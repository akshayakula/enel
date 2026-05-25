"""Tar+gzip the selected frames for upload to the GPU box."""

from __future__ import annotations

import hashlib
import tarfile
from pathlib import Path

from .log import event


def package_frames(frames_root: Path, out_path: Path) -> tuple[Path, str]:
    """Bundle frames_root/<cam>/<frame>.jpg into a flat tarball.

    Inside the tarball: images/<cam>__<frame>.jpg — flat layout COLMAP can index in one dir.
    Returns (path, sha256_hex).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    count = 0
    with tarfile.open(out_path, "w:gz", compresslevel=4) as tar:
        for cam_dir in sorted(p for p in frames_root.iterdir() if p.is_dir()):
            for jpg in sorted(cam_dir.glob("frame_*.jpg")):
                arcname = f"images/{cam_dir.name}__{jpg.name}"
                tar.add(jpg, arcname=arcname)
                count += 1
    # hash after closing so we read from a stable file
    with out_path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    event("packaging.tarball", path=str(out_path), bytes=out_path.stat().st_size,
          frames=count, sha256=digest)
    return out_path, digest


def package_directory(root: Path, out_path: Path) -> tuple[Path, str]:
    """Bundle a prepared job directory while preserving its relative layout."""
    if not root.is_dir():
        raise FileNotFoundError(f"not a directory: {root}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    count = 0
    with tarfile.open(out_path, "w:gz", compresslevel=4) as tar:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            tar.add(path, arcname=str(path.relative_to(root)))
            count += 1
    with out_path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    event("packaging.tarball", path=str(out_path), bytes=out_path.stat().st_size,
          files=count, sha256=digest)
    return out_path, digest
