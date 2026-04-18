#!/usr/bin/env python3

import argparse
import csv
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


@dataclass
class FrameMetrics:
    path: Path
    video_id: str
    sharpness: float
    brightness: float
    contrast: float
    score: float
    fingerprint: np.ndarray


def read_gray_image(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"Failed to read image: {path}")
    return image


def fingerprint(gray: np.ndarray) -> np.ndarray:
    tiny = cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA)
    return tiny.astype(np.float32)


def compute_metrics(path: Path, video_id: str) -> FrameMetrics:
    gray = read_gray_image(path)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    contrast = float(gray.std())
    return FrameMetrics(
        path=path,
        video_id=video_id,
        sharpness=sharpness,
        brightness=brightness,
        contrast=contrast,
        score=0.0,
        fingerprint=fingerprint(gray),
    )


def normalize(values: list[float]) -> list[float]:
    if not values:
        return []
    low = float(np.percentile(values, 10))
    high = float(np.percentile(values, 90))
    if high <= low:
        return [1.0 for _ in values]
    return [max(0.0, min(1.0, (value - low) / (high - low))) for value in values]


def exposure_score(brightness: float) -> float:
    return max(0.0, 1.0 - abs(brightness - 128.0) / 128.0)


def score_frames(frames: list[FrameMetrics]) -> list[FrameMetrics]:
    sharpness_norm = normalize([frame.sharpness for frame in frames])
    contrast_norm = normalize([frame.contrast for frame in frames])

    scored = []
    for frame, s_norm, c_norm in zip(frames, sharpness_norm, contrast_norm):
        frame.score = 0.7 * s_norm + 0.2 * c_norm + 0.1 * exposure_score(frame.brightness)
        scored.append(frame)
    return scored


def mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def select_frames(
    frames: list[FrameMetrics],
    bucket_size: int,
    top_k_per_video: int,
    dedupe_threshold: float,
) -> list[FrameMetrics]:
    if not frames:
        return []

    chosen = []
    for start in range(0, len(frames), bucket_size):
        bucket = frames[start : start + bucket_size]
        best = max(bucket, key=lambda frame: frame.score)
        chosen.append(best)

    deduped = []
    for frame in chosen:
        if deduped and mae(frame.fingerprint, deduped[-1].fingerprint) < dedupe_threshold:
            continue
        deduped.append(frame)

    if len(deduped) > top_k_per_video:
        deduped = sorted(deduped, key=lambda frame: frame.score, reverse=True)[:top_k_per_video]
        deduped = sorted(deduped, key=lambda frame: frame.path.name)

    return deduped


def find_video_frame_dirs(input_dir: Path) -> list[Path]:
    return sorted(path for path in input_dir.iterdir() if path.is_dir())


def find_images(frame_dir: Path) -> list[Path]:
    return sorted(path for path in frame_dir.iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS)


def copy_selected_frames(selected: list[FrameMetrics], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    for index, frame in enumerate(selected, start=1):
        target = output_dir / f"{frame.video_id}_{index:04d}{frame.path.suffix.lower()}"
        image = cv2.imread(str(frame.path), cv2.IMREAD_COLOR)
        cv2.imwrite(str(target), image)


def write_report(report_path: Path, frames: list[FrameMetrics], selected_paths: set[Path]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["video_id", "frame_path", "selected", "score", "sharpness", "brightness", "contrast"])
        for frame in frames:
            writer.writerow(
                [
                    frame.video_id,
                    str(frame.path),
                    "yes" if frame.path in selected_paths else "no",
                    f"{frame.score:.6f}",
                    f"{frame.sharpness:.6f}",
                    f"{frame.brightness:.6f}",
                    f"{frame.contrast:.6f}",
                ]
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Select sharper, less redundant frames for COLMAP.")
    parser.add_argument("--input-dir", required=True, help="Directory containing per-video extracted frame folders.")
    parser.add_argument("--output-dir", required=True, help="Output directory for selected COLMAP-ready images.")
    parser.add_argument("--report-path", required=True, help="CSV report for all scored frames.")
    parser.add_argument("--bucket-size", type=int, default=5, help="Choose the best frame from each temporal bucket.")
    parser.add_argument("--top-k-per-video", type=int, default=120, help="Maximum selected frames per video.")
    parser.add_argument("--dedupe-threshold", type=float, default=8.0, help="Smaller values are stricter dedupe.")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    report_path = Path(args.report_path)

    all_frames: list[FrameMetrics] = []
    selected: list[FrameMetrics] = []

    for frame_dir in find_video_frame_dirs(input_dir):
        images = find_images(frame_dir)
        if not images:
            continue

        print(f"[qc] scoring {frame_dir.name} ({len(images)} frames)")
        frames = [compute_metrics(path, frame_dir.name) for path in images]
        frames = score_frames(frames)
        picked = select_frames(
            frames,
            bucket_size=args.bucket_size,
            top_k_per_video=args.top_k_per_video,
            dedupe_threshold=args.dedupe_threshold,
        )
        print(f"[qc] selected {len(picked)} frames for {frame_dir.name}")

        all_frames.extend(frames)
        selected.extend(picked)

    copy_selected_frames(selected, output_dir)
    write_report(report_path, all_frames, {frame.path for frame in selected})

    print(f"[qc] wrote {len(selected)} images to {output_dir}")
    print(f"[qc] report written to {report_path}")


if __name__ == "__main__":
    main()
