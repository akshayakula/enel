#!/usr/bin/env bash

set -eu

IMAGES_DIR=""
WORKSPACE_DIR=""
MATCHER="exhaustive"
RUN_DENSE="0"
USE_GPU="1"
CAMERA_MODEL="OPENCV"
DEFAULT_FOCAL_FACTOR="1.2"

usage() {
  cat <<EOF
Usage:
  ./video_to_gaussian_splat/runpod_colmap.sh --images <images_dir> --workspace <workspace_dir> [options]

Options:
  --images <dir>           Flat folder of selected images, e.g. cam1_0001.jpg
  --workspace <dir>        Output COLMAP workspace
  --matcher <type>         exhaustive | sequential | vocab_tree (default: exhaustive)
  --dense                  Run dense reconstruction after sparse SfM
  --cpu                    Disable GPU usage for COLMAP
  --camera-model <model>   COLMAP camera model (default: OPENCV)
  --focal-factor <value>   Default focal length factor when EXIF is missing (default: 1.2)
  --help                   Show this message
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --images)
      IMAGES_DIR="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --matcher)
      MATCHER="$2"
      shift 2
      ;;
    --dense)
      RUN_DENSE="1"
      shift 1
      ;;
    --cpu)
      USE_GPU="0"
      shift 1
      ;;
    --camera-model)
      CAMERA_MODEL="$2"
      shift 2
      ;;
    --focal-factor)
      DEFAULT_FOCAL_FACTOR="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$IMAGES_DIR" ] || [ -z "$WORKSPACE_DIR" ]; then
  usage
  exit 1
fi

if ! command -v colmap >/dev/null 2>&1; then
  echo "COLMAP is not installed or not on PATH."
  exit 1
fi

IMAGES_DIR="$(cd "$IMAGES_DIR" && pwd)"
WORKSPACE_DIR="$(mkdir -p "$WORKSPACE_DIR" && cd "$WORKSPACE_DIR" && pwd)"
STRUCTURED_IMAGES_DIR="${WORKSPACE_DIR}/images_by_camera"
DATABASE_PATH="${WORKSPACE_DIR}/database.db"
SPARSE_DIR="${WORKSPACE_DIR}/sparse"
DENSE_DIR="${WORKSPACE_DIR}/dense"

rm -rf "$STRUCTURED_IMAGES_DIR"
mkdir -p "$STRUCTURED_IMAGES_DIR" "$SPARSE_DIR"

echo "[colmap] restructuring images by camera prefix"
find "$IMAGES_DIR" -type f | sort | while read -r image_path; do
  image_name="$(basename "$image_path")"
  camera_prefix="${image_name%%_*}"
  target_dir="${STRUCTURED_IMAGES_DIR}/${camera_prefix}"
  mkdir -p "$target_dir"
  ln -sf "$image_path" "${target_dir}/${image_name}"
done

echo "[colmap] feature extraction"
colmap feature_extractor \
  --database_path "$DATABASE_PATH" \
  --image_path "$STRUCTURED_IMAGES_DIR" \
  --ImageReader.camera_model "$CAMERA_MODEL" \
  --ImageReader.single_camera_per_folder 1 \
  --ImageReader.default_focal_length_factor "$DEFAULT_FOCAL_FACTOR" \
  --SiftExtraction.use_gpu "$USE_GPU"

case "$MATCHER" in
  exhaustive)
    echo "[colmap] exhaustive matching"
    colmap exhaustive_matcher \
      --database_path "$DATABASE_PATH" \
      --SiftMatching.use_gpu "$USE_GPU"
    ;;
  sequential)
    echo "[colmap] sequential matching"
    colmap sequential_matcher \
      --database_path "$DATABASE_PATH" \
      --SiftMatching.use_gpu "$USE_GPU"
    ;;
  vocab_tree)
    if [ -z "${COLMAP_VOCAB_TREE_PATH:-}" ]; then
      echo "COLMAP_VOCAB_TREE_PATH must be set for vocab_tree matching."
      exit 1
    fi
    echo "[colmap] vocab-tree matching"
    colmap vocab_tree_matcher \
      --database_path "$DATABASE_PATH" \
      --VocabTreeMatching.vocab_tree_path "$COLMAP_VOCAB_TREE_PATH" \
      --SiftMatching.use_gpu "$USE_GPU"
    ;;
  *)
    echo "Unsupported matcher: $MATCHER"
    exit 1
    ;;
esac

echo "[colmap] sparse mapping"
mkdir -p "${SPARSE_DIR}/0"
colmap mapper \
  --database_path "$DATABASE_PATH" \
  --image_path "$STRUCTURED_IMAGES_DIR" \
  --output_path "$SPARSE_DIR"

if [ "$RUN_DENSE" = "1" ]; then
  if [ ! -d "${SPARSE_DIR}/0" ]; then
    echo "Sparse model not found at ${SPARSE_DIR}/0"
    exit 1
  fi

  echo "[colmap] image undistortion"
  mkdir -p "$DENSE_DIR"
  colmap image_undistorter \
    --image_path "$STRUCTURED_IMAGES_DIR" \
    --input_path "${SPARSE_DIR}/0" \
    --output_path "$DENSE_DIR" \
    --output_type COLMAP

  echo "[colmap] patch-match stereo"
  colmap patch_match_stereo \
    --workspace_path "$DENSE_DIR" \
    --workspace_format COLMAP \
    --PatchMatchStereo.gpu_index 0

  echo "[colmap] stereo fusion"
  colmap stereo_fusion \
    --workspace_path "$DENSE_DIR" \
    --workspace_format COLMAP \
    --input_type geometric \
    --output_path "${DENSE_DIR}/fused.ply"
fi

echo
echo "[done] workspace ready at:"
echo "  ${WORKSPACE_DIR}"
