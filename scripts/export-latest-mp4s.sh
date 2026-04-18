#!/usr/bin/env bash

set -eu

OUT_DIR="${1:-/Users/puneetvelidi/enel/exports/latest-mp4}"
PLAYBACK_BASE="${PLAYBACK_BASE:-http://127.0.0.1:9996}"

mkdir -p "${OUT_DIR}"

python3 - "$OUT_DIR" "$PLAYBACK_BASE" <<'PY'
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

out_dir = Path(sys.argv[1])
playback_base = sys.argv[2].rstrip("/")
paths = ["cam1", "cam2", "cam3", "cam4"]

def fetch_json(url: str):
    with urllib.request.urlopen(url) as response:
        return json.load(response)

for path in paths:
    list_url = f"{playback_base}/list?path={urllib.parse.quote(path)}"
    try:
        spans = fetch_json(list_url)
    except Exception as exc:
        print(f"[warn] {path}: failed to fetch playback list: {exc}")
        continue

    if not spans:
        print(f"[warn] {path}: no recorded spans found")
        continue

    latest = max(spans, key=lambda item: item["start"])
    mp4_url = latest["url"] + "&format=mp4"
    target = out_dir / f"{path}.mp4"

    try:
        with urllib.request.urlopen(mp4_url) as response, target.open("wb") as fh:
            fh.write(response.read())
        print(f"[ok] wrote {target}")
    except Exception as exc:
        print(f"[warn] {path}: failed to export mp4: {exc}")
PY
