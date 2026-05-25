#!/usr/bin/env python3
"""Minimal but production-shaped gsplat trainer.

Reads COLMAP outputs from $JOB_DIR/{images,sparse/0}, trains a Gaussian splat,
and writes:
  $JOB_DIR/result/point_cloud.ply
  $JOB_DIR/result/training_log.json

Designed for short wall-clock budgets (5–10k steps). Image/SH parameters are
optimised but exposure/appearance embeddings are skipped — drone footage from
fixed cams of one scene over a short window doesn't need them, and they cost
both implementation surface area and a lot of training time.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from plyfile import PlyData, PlyElement
from tqdm import tqdm

import pycolmap
from gsplat import rasterization
from gsplat.strategy import DefaultStrategy


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", required=True, type=Path)
    p.add_argument("--result-dir", required=True, type=Path)
    p.add_argument("--max-steps", type=int, default=7000)
    p.add_argument("--sh-degree", type=int, default=3)
    p.add_argument("--init-pts", type=int, default=100_000)
    p.add_argument("--save-steps", type=int, default=7000)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def load_colmap(data_dir: Path) -> tuple[list, np.ndarray, np.ndarray, dict]:
    """Returns (cam_views, init_xyz, init_rgb, image_size_hint)."""
    rec = pycolmap.Reconstruction(str(data_dir / "sparse" / "0"))
    cameras = rec.cameras
    images_dir = data_dir / "images"

    views: list[dict] = []
    for image_id, image in rec.images.items():
        cam = cameras[image.camera_id]
        # Convert COLMAP world-to-camera (qvec, tvec) → 4x4 c2w.
        R = image.cam_from_world.rotation.matrix()  # 3x3, world->cam
        t = image.cam_from_world.translation        # 3
        w2c = np.eye(4, dtype=np.float64)
        w2c[:3, :3] = R
        w2c[:3, 3] = t
        c2w = np.linalg.inv(w2c)
        K = _intrinsics_to_K(cam)
        views.append({
            "name": image.name,
            "path": images_dir / image.name,
            "w": int(cam.width),
            "h": int(cam.height),
            "K": K.astype(np.float32),
            "c2w": c2w.astype(np.float32),
        })

    xyz = np.stack([p.xyz for p in rec.points3D.values()], axis=0).astype(np.float32)
    rgb = np.stack([p.color for p in rec.points3D.values()], axis=0).astype(np.float32) / 255.0
    return views, xyz, rgb, {"w": views[0]["w"], "h": views[0]["h"]}


def _intrinsics_to_K(cam: "pycolmap.Camera") -> np.ndarray:
    p = cam.params
    K = np.eye(3, dtype=np.float64)
    name = cam.model.name if hasattr(cam.model, "name") else str(cam.model)
    if "SIMPLE" in name or len(p) == 3:
        f, cx, cy = float(p[0]), float(p[1]), float(p[2])
        K[0, 0] = K[1, 1] = f
        K[0, 2] = cx
        K[1, 2] = cy
    else:
        # PINHOLE / OPENCV: fx, fy, cx, cy, ...
        fx, fy, cx, cy = (float(p[0]), float(p[1]), float(p[2]), float(p[3]))
        K[0, 0] = fx
        K[1, 1] = fy
        K[0, 2] = cx
        K[1, 2] = cy
    return K


def init_gaussians(
    xyz: np.ndarray, rgb: np.ndarray, target_n: int, sh_degree: int, device: torch.device
) -> dict[str, torch.nn.Parameter]:
    n = xyz.shape[0]
    if n < target_n:
        # Top up by jittering existing points; keeps colour distribution.
        extra = target_n - n
        idx = np.random.choice(n, size=extra, replace=True)
        jitter = (np.random.randn(extra, 3) * _scene_scale(xyz) * 0.01).astype(np.float32)
        xyz = np.concatenate([xyz, xyz[idx] + jitter], axis=0)
        rgb = np.concatenate([rgb, rgb[idx]], axis=0)
    elif n > target_n * 2:
        idx = np.random.choice(n, size=target_n, replace=False)
        xyz = xyz[idx]
        rgb = rgb[idx]

    n = xyz.shape[0]
    means = torch.tensor(xyz, device=device)
    # Initial scale = average nearest-neighbour distance / 2 (covers gaps).
    dists = _knn_distances(means, k=4)
    scales = torch.log(dists.clamp_min(1e-6) * 0.5).unsqueeze(-1).repeat(1, 3)
    quats = torch.zeros((n, 4), device=device)
    quats[:, 0] = 1.0
    opacities = torch.logit(torch.full((n,), 0.1, device=device))

    sh_coeffs = (sh_degree + 1) ** 2
    # DC term encodes mean colour in SH: f_dc = (rgb - 0.5) / 0.2820947917738781
    sh = torch.zeros((n, sh_coeffs, 3), device=device)
    sh[:, 0, :] = (torch.tensor(rgb, device=device) - 0.5) / 0.2820947917738781

    params = {
        "means": torch.nn.Parameter(means),
        "scales": torch.nn.Parameter(scales),
        "quats": torch.nn.Parameter(quats),
        "opacities": torch.nn.Parameter(opacities),
        "sh0": torch.nn.Parameter(sh[:, :1, :].contiguous()),  # DC
        "shN": torch.nn.Parameter(sh[:, 1:, :].contiguous()),  # higher-order
    }
    return params


def _scene_scale(xyz: np.ndarray) -> float:
    centroid = xyz.mean(0, keepdims=True)
    return float(np.linalg.norm(xyz - centroid, axis=1).mean()) or 1.0


@torch.no_grad()
def _knn_distances(pts: torch.Tensor, k: int = 4) -> torch.Tensor:
    """Mean distance to the k-nearest neighbours, in chunks to avoid OOM."""
    n = pts.shape[0]
    out = torch.empty(n, device=pts.device)
    chunk = 4096
    for i in range(0, n, chunk):
        d = torch.cdist(pts[i : i + chunk], pts)  # (chunk, n)
        topk = d.topk(k + 1, largest=False).values[:, 1 : k + 1]
        out[i : i + chunk] = topk.mean(1)
    return out


def make_optimizers(params: dict[str, torch.nn.Parameter], scene_extent: float):
    # LRs from the original 3DGS paper, scaled by scene extent for means.
    lrs = {
        "means": 1.6e-4 * scene_extent,
        "scales": 5e-3,
        "quats": 1e-3,
        "opacities": 5e-2,
        "sh0": 2.5e-3,
        "shN": 2.5e-3 / 20.0,
    }
    opts = {k: torch.optim.Adam([params[k]], lr=lr, eps=1e-15) for k, lr in lrs.items()}
    return opts


def render(params: dict[str, torch.nn.Parameter], view: dict, sh_degree_active: int, device):
    means = params["means"]
    quats = F.normalize(params["quats"], dim=-1)
    scales = torch.exp(params["scales"])
    opacities = torch.sigmoid(params["opacities"])
    colors = torch.cat([params["sh0"], params["shN"]], dim=1)  # (N, K, 3)

    K = torch.tensor(view["K"], device=device).unsqueeze(0)  # (1, 3, 3)
    c2w = torch.tensor(view["c2w"], device=device)
    viewmat = torch.linalg.inv(c2w).unsqueeze(0)             # (1, 4, 4)

    rendered, alphas, info = rasterization(
        means=means,
        quats=quats,
        scales=scales,
        opacities=opacities,
        colors=colors,
        viewmats=viewmat,
        Ks=K,
        width=view["w"],
        height=view["h"],
        sh_degree=sh_degree_active,
        packed=False,
    )
    return rendered.squeeze(0), alphas.squeeze(0), info


def load_image(view: dict, device) -> torch.Tensor:
    img = Image.open(view["path"]).convert("RGB").resize((view["w"], view["h"]))
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return torch.tensor(arr, device=device)


def save_ply(params: dict[str, torch.nn.Parameter], path: Path) -> None:
    means = params["means"].detach().cpu().numpy()
    scales = params["scales"].detach().cpu().numpy()
    quats = F.normalize(params["quats"], dim=-1).detach().cpu().numpy()
    opacities = params["opacities"].detach().cpu().numpy().reshape(-1, 1)
    sh0 = params["sh0"].detach().cpu().numpy().reshape(means.shape[0], -1)
    shN = params["shN"].detach().cpu().numpy().reshape(means.shape[0], -1)

    n = means.shape[0]
    dtype = [("x", "f4"), ("y", "f4"), ("z", "f4"),
             ("nx", "f4"), ("ny", "f4"), ("nz", "f4")]
    for i in range(sh0.shape[1]):
        dtype.append((f"f_dc_{i}", "f4"))
    for i in range(shN.shape[1]):
        dtype.append((f"f_rest_{i}", "f4"))
    dtype.append(("opacity", "f4"))
    for i in range(scales.shape[1]):
        dtype.append((f"scale_{i}", "f4"))
    for i in range(quats.shape[1]):
        dtype.append((f"rot_{i}", "f4"))

    arr = np.empty(n, dtype=dtype)
    arr["x"], arr["y"], arr["z"] = means[:, 0], means[:, 1], means[:, 2]
    arr["nx"] = arr["ny"] = arr["nz"] = 0.0
    for i in range(sh0.shape[1]):
        arr[f"f_dc_{i}"] = sh0[:, i]
    for i in range(shN.shape[1]):
        arr[f"f_rest_{i}"] = shN[:, i]
    arr["opacity"] = opacities[:, 0]
    for i in range(scales.shape[1]):
        arr[f"scale_{i}"] = scales[:, i]
    for i in range(quats.shape[1]):
        arr[f"rot_{i}"] = quats[:, i]

    path.parent.mkdir(parents=True, exist_ok=True)
    PlyData([PlyElement.describe(arr, "vertex")], text=False).write(str(path))


def main() -> int:
    args = parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        print("WARN: no CUDA — training will be unusably slow", flush=True)

    print("loading COLMAP", flush=True)
    views, init_xyz, init_rgb, _ = load_colmap(args.data_dir)
    if not views:
        raise RuntimeError("no posed images")
    scene_extent = _scene_scale(init_xyz)
    print(f"loaded {len(views)} views, {init_xyz.shape[0]} init pts, extent={scene_extent:.3f}",
          flush=True)

    params = init_gaussians(init_xyz, init_rgb, args.init_pts, args.sh_degree, device)
    opts = make_optimizers(params, scene_extent)
    strategy = DefaultStrategy(verbose=False)
    strategy.check_sanity(params, opts)
    state = strategy.initialize_state(scene_scale=scene_extent)

    losses = []
    pbar = tqdm(range(args.max_steps), desc="train")
    t0 = time.time()
    for step in pbar:
        view = views[step % len(views)]
        gt = load_image(view, device)

        sh_active = min(args.sh_degree, step // 1000)
        rendered, _, info = render(params, view, sh_active, device)

        l1 = (rendered - gt).abs().mean()
        loss = l1
        loss.backward()

        strategy.step_pre_backward(params, opts, state, step, info)
        for opt in opts.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        strategy.step_post_backward(params, opts, state, step, info)

        if step % 100 == 0:
            losses.append({"step": step, "loss": float(loss.item()),
                           "n_gauss": int(params["means"].shape[0])})
            pbar.set_postfix(loss=f"{loss.item():.4f}",
                             n=int(params["means"].shape[0]))

    elapsed = time.time() - t0
    out_ply = args.result_dir / "point_cloud.ply"
    save_ply(params, out_ply)
    log = {
        "elapsed_s": elapsed,
        "steps": args.max_steps,
        "n_gaussians_final": int(params["means"].shape[0]),
        "n_views": len(views),
        "losses": losses,
        "ply_path": str(out_ply),
    }
    (args.result_dir / "training_log.json").write_text(json.dumps(log, indent=2))
    print(f"done in {elapsed:.1f}s; {log['n_gaussians_final']} gaussians; ply={out_ply}",
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
