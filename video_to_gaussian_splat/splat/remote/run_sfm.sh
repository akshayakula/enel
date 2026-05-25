#!/usr/bin/env bash
# Run COLMAP SfM on a job directory.
#
# Layout expected:
#   $JOB_DIR/images/*.jpg            (flat directory of JPEGs)
# Produces:
#   $JOB_DIR/sparse/0/{cameras,images,points3D}.bin
#   $JOB_DIR/database.db
# This is the layout the gsplat COLMAP parser expects.
set -euo pipefail

JOB_DIR="${1:?usage: run_sfm.sh JOB_DIR}"
IMAGES="$JOB_DIR/images"
SPARSE="$JOB_DIR/sparse"

mkdir -p "$SPARSE"

if [[ ! -d "$IMAGES" ]] || [[ -z "$(ls -A "$IMAGES" 2>/dev/null)" ]]; then
  echo "run_sfm: no images at $IMAGES" >&2
  exit 1
fi

DB="$JOB_DIR/database.db"
[[ -f "$DB" ]] && rm -f "$DB"

# COLMAP's CLI still initializes Qt. Lambda shells have no display server, so
# force Qt onto its headless backend before any COLMAP command runs.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
COLMAP_USE_GPU="${COLMAP_USE_GPU:-0}"

echo "run_sfm: feature extraction"
colmap feature_extractor \
  --database_path "$DB" \
  --image_path "$IMAGES" \
  --ImageReader.single_camera_per_folder 0 \
  --ImageReader.camera_model OPENCV \
  --SiftExtraction.use_gpu "$COLMAP_USE_GPU" \
  --SiftExtraction.estimate_affine_shape 0 \
  --SiftExtraction.domain_size_pooling 0 \
  --SiftExtraction.max_image_size 1600

N_IMG=$(ls -1 "$IMAGES" | wc -l)
PAIRS="$JOB_DIR/pairs.txt"
if [[ -f "$PAIRS" ]]; then
  echo "run_sfm: matching $N_IMG images from pair list $(wc -l < "$PAIRS") pairs"
  colmap matches_importer \
    --database_path "$DB" \
    --match_list_path "$PAIRS" \
    --match_type pairs \
    --SiftMatching.use_gpu "$COLMAP_USE_GPU"
elif [[ "$N_IMG" -le 400 ]]; then
  echo "run_sfm: exhaustive matching $N_IMG images"
  colmap exhaustive_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu "$COLMAP_USE_GPU"
else
  echo "run_sfm: sequential matching $N_IMG images"
  colmap sequential_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu "$COLMAP_USE_GPU" \
    --SequentialMatching.overlap 10 \
    --SequentialMatching.loop_detection 1
fi

echo "run_sfm: mapping"
colmap mapper \
  --database_path "$DB" \
  --image_path "$IMAGES" \
  --output_path "$SPARSE" \
  --Mapper.ba_global_function_tolerance 1e-4 \
  --Mapper.num_threads 0

# Pick the largest reconstruction (model with most images).
BEST_MODEL=$(find "$SPARSE" -mindepth 1 -maxdepth 1 -type d | while read d; do
  count=$(stat -c %s "$d/images.bin" 2>/dev/null || echo 0)
  echo "$count $d"
done | sort -rn | head -n1 | awk '{print $2}')
if [[ -z "${BEST_MODEL:-}" ]]; then
  echo "run_sfm: COLMAP produced no reconstruction" >&2
  exit 2
fi
echo "run_sfm: best model -> $BEST_MODEL"

if [[ "$BEST_MODEL" != "$SPARSE/0" ]]; then
  rm -rf "$SPARSE/0"
  mv "$BEST_MODEL" "$SPARSE/0"
fi

# gsplat's COLMAP parser likes a points3D.txt or .bin; we have .bin already.
echo "run_sfm: done — $(ls -lh "$SPARSE/0" | tail -n+2 | wc -l) files in sparse/0"
