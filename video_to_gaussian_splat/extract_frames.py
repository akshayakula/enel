#!/usr/bin/env python3

import argparse
import subprocess
from pathlib import Path


VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v"}


def run_ffmpeg(video_path: Path, output_dir: Path, fps: float, jpeg_quality: int, width: int | None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    vf_parts = [f"fps={fps}"]
    if width:
        vf_parts.append(f"scale={width}:-2")
    vf = ",".join(vf_parts)

    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        vf,
        "-q:v",
        str(jpeg_quality),
        str(output_dir / "frame_%06d.jpg"),
    ]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract frames from all videos in a directory.")
    parser.add_argument("--input-dir", required=True, help="Directory containing raw videos.")
    parser.add_argument("--output-dir", required=True, help="Directory where extracted frame folders are written.")
    parser.add_argument("--fps", type=float, default=1.0, help="Extraction rate in frames per second.")
    parser.add_argument("--jpeg-quality", type=int, default=2, help="FFmpeg JPEG quality scale; lower is better.")
    parser.add_argument("--width", type=int, default=None, help="Optional resize width. Height is auto-scaled.")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    videos = sorted(
        path for path in input_dir.iterdir() if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )

    if not videos:
        raise SystemExit(f"No videos found in {input_dir}")

    for video_path in videos:
        target_dir = output_dir / video_path.stem
        print(f"[extract] {video_path.name} -> {target_dir}")
        run_ffmpeg(video_path, target_dir, args.fps, args.jpeg_quality, args.width)


if __name__ == "__main__":
    main()
