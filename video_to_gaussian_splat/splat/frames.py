"""Local frame extraction + quality control.

Why local: drone recordings can be many GB. Frames after QC are typically
< 200 MB. Extracting locally and uploading only frames keeps the wall-clock
budget tight and avoids paying the GPU instance to wait on ffmpeg.
"""

from __future__ import annotations

import csv
import math
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np

from .config import FrameConfig
from .log import event


VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".ts"}


@dataclass(frozen=True)
class CameraInput:
    cam_id: str          # e.g. "cam1"
    video_path: Path


@dataclass
class FrameRecord:
    cam_id: str
    frame_path: Path
    sharpness: float
    brightness: float
    contrast: float
    score: float
    selected: bool


def discover_cameras(input_path: Path) -> list[CameraInput]:
    """Find video files. A directory of files = one camera per file (cam_id from stem)."""
    if input_path.is_file():
        return [CameraInput(cam_id=input_path.stem, video_path=input_path)]
    cams: list[CameraInput] = []
    if not input_path.is_dir():
        raise FileNotFoundError(f"No such file or directory: {input_path}")
    for entry in sorted(input_path.iterdir()):
        if entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
            cams.append(CameraInput(cam_id=_safe_cam_id(entry.stem), video_path=entry))
        elif entry.is_dir():
            # MediaMTX writes recordings/<cam>/<segment>.mp4 — concat-list style.
            segments = sorted(p for p in entry.iterdir() if p.suffix.lower() in VIDEO_EXTENSIONS)
            if not segments:
                continue
            video = segments[0] if len(segments) == 1 else _concat_video(entry, segments)
            cams.append(CameraInput(cam_id=_safe_cam_id(entry.name), video_path=video))
    if not cams:
        raise FileNotFoundError(f"No video files found under {input_path}")
    return cams


def _safe_cam_id(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_") or "cam"


def _concat_video(work_dir: Path, segments: list[Path]) -> Path:
    """ffmpeg concat-demuxer-style merge (no re-encode)."""
    list_path = work_dir / "_concat.txt"
    list_path.write_text("\n".join(f"file '{p}'" for p in segments) + "\n")
    out = work_dir / f"{work_dir.name}_concat.mp4"
    if out.exists():
        return out
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(list_path),
            "-c", "copy", str(out),
        ],
        check=True,
    )
    return out


def extract_and_select(
    cameras: Iterable[CameraInput],
    out_root: Path,
    cfg: FrameConfig,
) -> list[FrameRecord]:
    """Extract every Nth frame, score them, keep top-K per camera."""
    cameras = list(cameras)
    out_root.mkdir(parents=True, exist_ok=True)
    qc_path = out_root.parent / "qc_report.csv"

    all_records: list[FrameRecord] = []
    with ThreadPoolExecutor(max_workers=min(8, len(cameras) or 1)) as pool:
        futures = {pool.submit(_extract_one, cam, out_root, cfg): cam for cam in cameras}
        for fut in as_completed(futures):
            cam = futures[fut]
            recs = fut.result()
            event("frames.extracted", cam=cam.cam_id, count=len(recs))
            all_records.extend(recs)

    selected = _select_top_k(all_records, cfg.target_per_camera)
    _write_qc(qc_path, all_records, selected)
    _prune_unselected(all_records, selected)

    kept = [r for r in selected]
    event("frames.selected", total=len(kept))
    return kept


def _extract_one(cam: CameraInput, out_root: Path, cfg: FrameConfig) -> list[FrameRecord]:
    cam_dir = out_root / cam.cam_id
    cam_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: ffmpeg → JPEGs at sample_fps.
    pattern = cam_dir / "frame_%06d.jpg"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(cam.video_path),
            "-vf", f"fps={cfg.sample_fps},scale='if(gt(iw,ih),{cfg.long_edge_px},-2)':"
                   f"'if(gt(iw,ih),-2,{cfg.long_edge_px})'",
            "-q:v", str(_jpeg_quality_to_ffmpeg(cfg.jpeg_quality)),
            str(pattern),
        ],
        check=True,
    )

    # Step 2: score every frame.
    records: list[FrameRecord] = []
    for jpg in sorted(cam_dir.glob("frame_*.jpg")):
        img = cv2.imread(str(jpg), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        sharpness = float(cv2.Laplacian(img, cv2.CV_64F).var())
        brightness = float(img.mean())
        contrast = float(img.std())
        score = _quality_score(sharpness, brightness, contrast, cfg)
        records.append(FrameRecord(
            cam_id=cam.cam_id, frame_path=jpg,
            sharpness=sharpness, brightness=brightness, contrast=contrast,
            score=score, selected=False,
        ))
    return records


def _jpeg_quality_to_ffmpeg(q: int) -> int:
    # ffmpeg -q:v takes 2 (best) … 31 (worst). Map [50..100] → [10..2].
    q = max(50, min(100, int(q)))
    return max(2, int(round(31 - (q - 50) * (29 / 50))))


def _quality_score(sharpness: float, brightness: float, contrast: float, cfg: FrameConfig) -> float:
    if sharpness < cfg.min_sharpness:
        return 0.0
    if brightness < cfg.min_brightness or brightness > cfg.max_brightness:
        return 0.0
    # Soft-clip sharpness via tanh so a few super-sharp frames don't dominate selection.
    s = math.tanh(sharpness / 80.0)
    # Penalise extreme exposure mildly.
    bright_term = 1.0 - abs(brightness - 128.0) / 128.0
    contrast_term = math.tanh(contrast / 60.0)
    return float(0.6 * s + 0.2 * bright_term + 0.2 * contrast_term)


def _select_top_k(records: list[FrameRecord], k_per_cam: int) -> list[FrameRecord]:
    """Pick top-K per camera, but spread the picks across the timeline so we
    don't cluster all selections in one sharp segment (bad for SfM coverage)."""
    by_cam: dict[str, list[FrameRecord]] = {}
    for r in records:
        by_cam.setdefault(r.cam_id, []).append(r)

    chosen: list[FrameRecord] = []
    for cam_id, recs in by_cam.items():
        recs.sort(key=lambda r: r.frame_path.name)  # temporal order
        if len(recs) <= k_per_cam:
            for r in recs:
                if r.score > 0:
                    r.selected = True
                    chosen.append(r)
            continue
        # Bucket the timeline into k_per_cam windows; within each, pick best-scoring.
        buckets = np.array_split(np.array(recs, dtype=object), k_per_cam)
        for bucket in buckets:
            if len(bucket) == 0:
                continue
            best = max(bucket, key=lambda r: r.score)
            if best.score <= 0:
                continue
            best.selected = True
            chosen.append(best)
    return chosen


def _write_qc(path: Path, all_records: list[FrameRecord], selected: list[FrameRecord]) -> None:
    selected_set = {id(r) for r in selected}
    with path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["video_id", "frame_path", "selected", "score", "sharpness", "brightness", "contrast"])
        for r in sorted(all_records, key=lambda r: (r.cam_id, r.frame_path.name)):
            writer.writerow([
                r.cam_id, str(r.frame_path),
                "yes" if id(r) in selected_set else "no",
                f"{r.score:.6f}", f"{r.sharpness:.6f}",
                f"{r.brightness:.6f}", f"{r.contrast:.6f}",
            ])


def _prune_unselected(all_records: list[FrameRecord], selected: list[FrameRecord]) -> None:
    """Delete unselected JPEGs to shrink the upload tarball."""
    keep = {r.frame_path for r in selected}
    removed = 0
    for r in all_records:
        if r.frame_path not in keep and r.frame_path.exists():
            r.frame_path.unlink()
            removed += 1
    event("frames.pruned", removed=removed)
