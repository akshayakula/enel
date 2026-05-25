#!/usr/bin/env bash
# Run InstantSplat's MASt3R geometry init and Gaussian optimization on a staged job.
set -euo pipefail

REMOTE_ROOT="${1:?usage: run_instantsplat.sh REMOTE_ROOT JOB_DIR ITERATIONS IMAGE_SIZE RENDER_VIDEO}"
JOB_DIR="${2:?usage: run_instantsplat.sh REMOTE_ROOT JOB_DIR ITERATIONS IMAGE_SIZE RENDER_VIDEO}"
ITERATIONS="${3:-1000}"
IMAGE_SIZE="${4:-512}"
RENDER_VIDEO="${5:-0}"

REPO_DIR="$REMOTE_ROOT/repos/InstantSplat"
VENV="$REMOTE_ROOT/instantsplat-venv"
IMAGES="$JOB_DIR/images"
RESULT_DIR="$JOB_DIR/result"
MODEL_DIR="$RESULT_DIR/instantsplat_model"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "run_instantsplat: missing repo at $REPO_DIR" >&2
  exit 2
fi
if [[ ! -d "$IMAGES" ]] || [[ -z "$(find "$IMAGES" -maxdepth 1 -type f | head -n 1)" ]]; then
  echo "run_instantsplat: no images at $IMAGES" >&2
  exit 2
fi

mkdir -p "$RESULT_DIR" "$MODEL_DIR"
N_VIEWS="$(find "$IMAGES" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) | wc -l | tr -d ' ')"
if [[ "$N_VIEWS" -lt 2 ]]; then
  echo "run_instantsplat: need at least 2 images, found $N_VIEWS" >&2
  exit 2
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
cd "$REPO_DIR"

echo "run_instantsplat: MASt3R init on $N_VIEWS views"
python -W ignore ./init_geo.py \
  -s "$JOB_DIR" \
  -m "$MODEL_DIR" \
  --n_views "$N_VIEWS" \
  --image_size "$IMAGE_SIZE" \
  --focal_avg \
  --co_vis_dsp \
  --conf_aware_ranking \
  --infer_video \
  > "$RESULT_DIR/01_init_geo.log" 2>&1

echo "run_instantsplat: training $ITERATIONS iterations"
python ./train.py \
  -s "$JOB_DIR" \
  -m "$MODEL_DIR" \
  -r 1 \
  --n_views "$N_VIEWS" \
  --iterations "$ITERATIONS" \
  --pp_optimizer \
  --optim_pose \
  > "$RESULT_DIR/02_train.log" 2>&1

if [[ "$RENDER_VIDEO" == "1" ]]; then
  echo "run_instantsplat: rendering interpolation video"
  python ./render.py \
    -s "$JOB_DIR" \
    -m "$MODEL_DIR" \
    -r 1 \
    --n_views "$N_VIEWS" \
    --iterations "$ITERATIONS" \
    --infer_video \
    > "$RESULT_DIR/03_render.log" 2>&1
fi

PLY="$MODEL_DIR/point_cloud/iteration_${ITERATIONS}/point_cloud.ply"
if [[ ! -s "$PLY" ]]; then
  PLY="$(find "$MODEL_DIR/point_cloud" -name point_cloud.ply 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [[ -z "${PLY:-}" ]] || [[ ! -s "$PLY" ]]; then
  echo "run_instantsplat: no point_cloud.ply produced under $MODEL_DIR" >&2
  exit 3
fi

cp "$PLY" "$RESULT_DIR/point_cloud.ply"
[[ -f "$MODEL_DIR/input.ply" ]] && cp "$MODEL_DIR/input.ply" "$RESULT_DIR/input.ply"
[[ -f "$MODEL_DIR/cameras.json" ]] && cp "$MODEL_DIR/cameras.json" "$RESULT_DIR/cameras.json"

python - <<PY
import json
from pathlib import Path

result = {
    "n_views": int("$N_VIEWS"),
    "iterations": int("$ITERATIONS"),
    "image_size": int("$IMAGE_SIZE"),
    "model_dir": "$MODEL_DIR",
    "point_cloud": "$RESULT_DIR/point_cloud.ply",
    "render_video": "$RENDER_VIDEO" == "1",
}
Path("$RESULT_DIR/training_log.json").write_text(json.dumps(result, indent=2))
PY

echo "run_instantsplat: done -> $RESULT_DIR/point_cloud.ply"
