"""Experimental synchronized multi-view staging utilities."""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .frames import VIDEO_EXTENSIONS
from .log import event


@dataclass(frozen=True)
class VideoSource:
    cam_id: str
    path: Path
    duration_s: float


@dataclass(frozen=True)
class PreparedMultiviewInput:
    directory: Path
    sources: list[VideoSource]
    manifest_path: Path


def prepare_concatenated_multiview_inputs(
    input_paths: Iterable[Path],
    output_dir: Path,
    *,
    prefer_normalized: bool = True,
) -> PreparedMultiviewInput:
    """Normalize one or more feed paths into one video file per camera.

    Directory inputs may be either:
      - one file per camera, or
      - camera subdirectories containing chronological segments.

    Multiple segments for the same camera are concatenated with ffmpeg. Single
    files are symlinked into output_dir, falling back to copy on filesystems that
    do not permit symlinks.
    """
    groups = discover_multiview_segment_groups(
        input_paths,
        prefer_normalized=prefer_normalized,
    )
    if not groups:
        raise FileNotFoundError("no video feeds found in input paths")

    output_dir.mkdir(parents=True, exist_ok=True)
    sources: list[VideoSource] = []
    segment_manifest: list[dict] = []
    for cam_id, segments in sorted(groups.items()):
        if len(segments) == 1:
            src = segments[0]
            out = output_dir / f"{cam_id}{src.suffix.lower()}"
            _link_or_copy(src, out)
            event("multiview.feed.linked", cam=cam_id, source=str(src), output=str(out))
        else:
            out = output_dir / f"{cam_id}.mp4"
            _concat_segments(segments, out)
            event("multiview.feed.concatenated", cam=cam_id, segments=len(segments), output=str(out))
        duration = _probe_duration(out)
        if duration <= 0:
            raise ValueError(f"feed {cam_id} has no usable duration after staging")
        sources.append(VideoSource(cam_id=cam_id, path=out, duration_s=duration))
        segment_manifest.append({
            "cam_id": cam_id,
            "output": str(out.resolve()),
            "duration_s": duration,
            "segments": [str(p.resolve()) for p in segments],
        })

    manifest_path = output_dir / "feeds_manifest.json"
    manifest_path.write_text(json.dumps({
        "output_dir": str(output_dir.resolve()),
        "feed_count": len(sources),
        "feeds": segment_manifest,
    }, indent=2))
    return PreparedMultiviewInput(output_dir, sources, manifest_path)


def discover_multiview_segment_groups(
    input_paths: Iterable[Path],
    *,
    prefer_normalized: bool = True,
) -> dict[str, list[Path]]:
    """Group input videos by camera id while keeping per-camera segments sorted."""
    raw_paths = list(input_paths)
    grouped: dict[str, list[Path]] = {}
    for raw_path in raw_paths:
        path = raw_path.expanduser().resolve()
        if path.is_file():
            if path.suffix.lower() in VIDEO_EXTENSIONS:
                grouped.setdefault(_segment_camera_id(path.stem), []).append(path)
            continue
        if not path.is_dir():
            raise FileNotFoundError(f"no such input path: {raw_path}")

        # MediaMTX-style recordings/<camera>/<segment>.mp4.
        found_camera_subdirs = False
        for child in sorted(path.iterdir()):
            if child.is_dir():
                segments = sorted(
                    p.resolve()
                    for p in child.iterdir()
                    if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
                )
                if segments:
                    found_camera_subdirs = True
                    grouped.setdefault(_camera_id(child.name), []).extend(segments)

        direct_videos = sorted(
            child.resolve()
            for child in path.iterdir()
            if child.is_file() and child.suffix.lower() in VIDEO_EXTENSIONS
        )
        if not direct_videos:
            continue

        if not found_camera_subdirs and (
            len(raw_paths) > 1 or _looks_like_segment_directory(direct_videos)
        ):
            grouped.setdefault(_camera_id(path.name), []).extend(direct_videos)
        else:
            # Flat export directories with one or more files per camera.
            for child in direct_videos:
                if _is_combined_export(child.stem):
                    continue
                grouped.setdefault(_segment_camera_id(child.stem), []).append(child)

    return {
        cam_id: _choose_segment_set(segments, prefer_normalized=prefer_normalized)
        for cam_id, segments in sorted(grouped.items())
        if segments
    }


def stage_synchronized_keyframes(
    input_dir: Path,
    output_dir: Path,
    *,
    timestamps: int = 40,
    long_edge_px: int = 960,
    temporal_neighbors: int = 2,
    cross_view_drift: int = 1,
    prefer_normalized: bool = True,
) -> dict:
    """Create a COLMAP-ready job directory from synchronized multi-camera videos.

    Output layout:
      output_dir/images/<cam>__tNNNNNN.jpg
      output_dir/pairs.txt
      output_dir/manifest.json

    The pair list intentionally keeps matching sparse:
      - same/near timestamps across cameras
      - neighboring timestamps within each camera
    """
    sources = discover_multiview_sources(input_dir, prefer_normalized=prefer_normalized)
    return stage_synchronized_keyframes_from_sources(
        sources,
        input_dir=input_dir,
        output_dir=output_dir,
        timestamps=timestamps,
        long_edge_px=long_edge_px,
        temporal_neighbors=temporal_neighbors,
        cross_view_drift=cross_view_drift,
    )


def stage_synchronized_keyframes_from_sources(
    sources: list[VideoSource],
    *,
    input_dir: Path,
    output_dir: Path,
    timestamps: int = 40,
    long_edge_px: int = 960,
    temporal_neighbors: int = 2,
    cross_view_drift: int = 1,
) -> dict:
    """Create a COLMAP/InstantSplat-ready image set from known video sources."""
    if len(sources) < 2:
        raise ValueError(f"need at least 2 camera videos under {input_dir}")
    if timestamps < 1:
        raise ValueError("timestamps must be >= 1")

    output_dir.mkdir(parents=True, exist_ok=True)
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    common_duration = min(src.duration_s for src in sources)
    if common_duration <= 0:
        raise ValueError("input videos have no usable common duration")

    times = _timestamp_grid(common_duration, timestamps)
    image_names: dict[str, list[str]] = {}
    for src in sources:
        names: list[str] = []
        for idx, ts in enumerate(times):
            name = f"{src.cam_id}__t{idx:06d}.jpg"
            out = images_dir / name
            _extract_frame(src.path, out, ts, long_edge_px)
            names.append(name)
        image_names[src.cam_id] = names

    pairs = generate_pairs(
        image_names,
        temporal_neighbors=temporal_neighbors,
        cross_view_drift=cross_view_drift,
    )
    pairs_path = output_dir / "pairs.txt"
    pairs_path.write_text("".join(f"{a} {b}\n" for a, b in pairs))

    manifest = {
        "input_dir": str(input_dir.resolve()),
        "output_dir": str(output_dir.resolve()),
        "common_duration_s": common_duration,
        "timestamps": times,
        "long_edge_px": long_edge_px,
        "temporal_neighbors": temporal_neighbors,
        "cross_view_drift": cross_view_drift,
        "cameras": [
            {
                "cam_id": src.cam_id,
                "path": str(src.path.resolve()),
                "duration_s": src.duration_s,
                "frames": len(image_names[src.cam_id]),
            }
            for src in sources
        ],
        "image_count": sum(len(v) for v in image_names.values()),
        "pair_count": len(pairs),
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    event("multiview.keyframes.staged", images=manifest["image_count"], pairs=manifest["pair_count"])
    return manifest


def discover_multiview_sources(input_dir: Path, *, prefer_normalized: bool = True) -> list[VideoSource]:
    """Find camera videos while excluding combined/mosaic convenience exports."""
    if not input_dir.is_dir():
        raise FileNotFoundError(f"not a directory: {input_dir}")

    candidates: dict[str, list[Path]] = {}
    for path in sorted(input_dir.iterdir()):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        stem = path.stem
        if _is_combined_export(stem):
            continue
        cam_id = _camera_id(stem)
        candidates.setdefault(cam_id, []).append(path)

    sources: list[VideoSource] = []
    for cam_id, paths in sorted(candidates.items()):
        chosen = _choose_video(paths, prefer_normalized=prefer_normalized)
        duration = _probe_duration(chosen)
        if duration > 0:
            sources.append(VideoSource(cam_id=cam_id, path=chosen, duration_s=duration))
    return sources


def generate_pairs(
    image_names: dict[str, list[str]],
    *,
    temporal_neighbors: int,
    cross_view_drift: int,
) -> list[tuple[str, str]]:
    """Generate deterministic sparse COLMAP match pairs."""
    pairs: set[tuple[str, str]] = set()
    cameras = sorted(image_names)

    for cam in cameras:
        names = image_names[cam]
        for i, name in enumerate(names):
            for step in range(1, temporal_neighbors + 1):
                j = i + step
                if j < len(names):
                    _add_pair(pairs, name, names[j])

    for left_idx, cam_a in enumerate(cameras):
        for cam_b in cameras[left_idx + 1:]:
            names_a = image_names[cam_a]
            names_b = image_names[cam_b]
            for i, name_a in enumerate(names_a):
                for drift in range(-cross_view_drift, cross_view_drift + 1):
                    j = i + drift
                    if 0 <= j < len(names_b):
                        _add_pair(pairs, name_a, names_b[j])

    return sorted(pairs)


def _timestamp_grid(duration_s: float, count: int) -> list[float]:
    # Use bin centers to avoid first/last-frame decoder edge cases.
    step = duration_s / count
    return [round((idx + 0.5) * step, 6) for idx in range(count)]


def _extract_frame(video_path: Path, out_path: Path, timestamp_s: float, long_edge_px: int) -> None:
    scale = (
        f"scale='if(gt(iw,ih),{long_edge_px},-2)':"
        f"'if(gt(iw,ih),-2,{long_edge_px})'"
    )
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{timestamp_s:.6f}",
            "-i", str(video_path),
            "-frames:v", "1",
            "-vf", scale,
            "-q:v", "3",
            str(out_path),
        ],
        check=True,
    )


def _probe_duration(video_path: Path) -> float:
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    try:
        value = float(proc.stdout.strip())
    except ValueError:
        return 0.0
    return value if math.isfinite(value) else 0.0


def _camera_id(stem: str) -> str:
    cam = re.sub(r"(_normalized|_compiled)$", "", stem)
    cam = re.sub(r"[^A-Za-z0-9_-]+", "_", cam).strip("_")
    return cam or "cam"


def _is_combined_export(stem: str) -> bool:
    lowered = stem.lower()
    return lowered in {"all_cams_combined", "combined"} or "combined" in lowered


def _choose_video(paths: Iterable[Path], *, prefer_normalized: bool) -> Path:
    ordered = sorted(paths)
    if prefer_normalized:
        normalized = [p for p in ordered if p.stem.endswith("_normalized")]
        if normalized:
            return normalized[0]
    return ordered[0]


def _choose_segment_set(paths: Iterable[Path], *, prefer_normalized: bool) -> list[Path]:
    ordered = sorted(dict.fromkeys(paths))
    if prefer_normalized:
        normalized = [p for p in ordered if p.stem.endswith("_normalized")]
        if normalized:
            return normalized
    return ordered


def _segment_camera_id(stem: str) -> str:
    cam = _camera_id(stem)
    patterns = (
        r"([_-](part|segment|seg|clip)\d+)$",
        r"[_-]\d{8}T\d{6}Z?$",
        r"[_-]\d{4}-\d{2}-\d{2}.*$",
        r"[_-]\d{6,}$",
    )
    for pattern in patterns:
        cam = re.sub(pattern, "", cam, flags=re.IGNORECASE)
    return _camera_id(cam)


def _looks_like_segment_directory(paths: list[Path]) -> bool:
    if len(paths) <= 1:
        return False
    segment_name = re.compile(
        r"^(seg|segment|part|clip)?[_-]?\d+$|^\d{8}T\d{6}Z?$|^\d{4}-\d{2}-\d{2}.*$",
        re.IGNORECASE,
    )
    return all(segment_name.match(p.stem) for p in paths)


def _link_or_copy(src: Path, out: Path) -> None:
    if out.exists() or out.is_symlink():
        out.unlink()
    try:
        out.symlink_to(src)
    except OSError:
        shutil.copy2(src, out)


def _concat_segments(segments: list[Path], out: Path) -> None:
    list_path = out.with_suffix(".concat.txt")
    list_path.write_text("".join(f"file '{_ffmpeg_concat_escape(p)}'\n" for p in segments))
    if out.exists():
        out.unlink()
    copy_cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-c", "copy", str(out),
    ]
    proc = subprocess.run(copy_cmd, text=True, capture_output=True)
    if proc.returncode == 0:
        return
    fallback_cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-an", str(out),
    ]
    subprocess.run(fallback_cmd, check=True)


def _ffmpeg_concat_escape(path: Path) -> str:
    return str(path.resolve()).replace("'", r"'\''")


def _add_pair(pairs: set[tuple[str, str]], a: str, b: str) -> None:
    if a == b:
        return
    pairs.add((a, b) if a < b else (b, a))
