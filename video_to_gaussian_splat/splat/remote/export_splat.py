#!/usr/bin/env python3
"""Convert a 3DGS .ply (3DGS-style: f_dc_*, f_rest_*, opacity, scale_*, rot_*) into the
.splat binary format used by antimatter15's web viewer.

Format (32 bytes per gaussian, little-endian):
  position   : float32 x 3   (12 B)
  scale      : float32 x 3   (12 B)   — already-exp'd scales
  color RGBA : uint8   x 4   ( 4 B)
  rotation   : uint8   x 4   ( 4 B)   — (q * 128) + 128
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from plyfile import PlyData


SH_C0 = 0.28209479177387814


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ply", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()

    data = PlyData.read(str(args.ply))["vertex"].data

    xyz = np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float32)
    scales = np.exp(np.stack([data[f"scale_{i}"] for i in range(3)], axis=1)).astype(np.float32)
    rots = np.stack([data[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float32)
    rots = rots / np.linalg.norm(rots, axis=1, keepdims=True).clip(min=1e-9)

    f_dc = np.stack([data[f"f_dc_{i}"] for i in range(3)], axis=1).astype(np.float32)
    rgb = np.clip(0.5 + SH_C0 * f_dc, 0.0, 1.0)
    opacity = 1.0 / (1.0 + np.exp(-data["opacity"].astype(np.float32)))

    # Sort: most-impactful gaussians first (alpha * volume).
    importance = opacity * scales.prod(axis=1)
    order = np.argsort(-importance)

    n = xyz.shape[0]
    out = np.zeros(n, dtype=[
        ("pos", "<f4", (3,)),
        ("scl", "<f4", (3,)),
        ("rgba", "u1", (4,)),
        ("rot", "u1", (4,)),
    ])
    out["pos"] = xyz[order]
    out["scl"] = scales[order]
    out["rgba"] = np.concatenate([
        np.clip(rgb[order] * 255.0, 0, 255).astype(np.uint8),
        np.clip(opacity[order, None] * 255.0, 0, 255).astype(np.uint8),
    ], axis=1)
    out["rot"] = np.clip(rots[order] * 128.0 + 128.0, 0, 255).astype(np.uint8)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.tofile(args.out)
    print(f"wrote {args.out} ({args.out.stat().st_size:,} bytes, {n} gaussians)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
