# Multi-Feed 3DGS Preview Experiment

## Goal

Prove whether the Lambda splat pipeline can produce a usable multi-video 3DGS
preview in minutes, then identify which optimization is worth productizing.

Target for a preview run:

- Wall clock: under 5 minutes on a warm Lambda instance.
- SfM: at least 60% of selected images registered, mean reprojection error under
  2 px, and enough sparse points for gsplat initialization.
- Output: `scene.splat` opens in the existing viewer without obvious collapse.

## Hypothesis

Multi-feed capture should speed reconstruction only if it reduces ambiguity and
matching work. Treating more feeds as more unordered frames can make SfM slower.
The winning approach should use synchronized keyframes plus constrained match
pairs:

- Same timestamp across cameras.
- Neighboring timestamps within each camera.
- Optional cross-camera +/-1 timestamp pairs for small sync drift.

## Preflight Results

Local:

- `ffmpeg` and `ffprobe` are installed.
- Python venv imports `cv2`, `numpy`, and `requests`.
- Latest clean two-feed batch:
  `exports/compiled/2026-04-19T17-48-36-433Z`
  - `cam1_normalized.mp4`: 640x360, 30 fps, 164 frames, 5.47 s.
  - `cam2_normalized.mp4`: 640x360, about 30 fps, 787 frames, 26.33 s.
  - `all_cams_combined.mp4` exists and should be excluded from SfM inputs.
- One older file is corrupt:
  `exports/compiled/2026-04-19T17-46-50-426Z/cam1_normalized.mp4`.
- Existing Kiri camera exports exist with 13 and 265 camera poses, useful as
  reference artifacts but not a direct substitute for rig calibration.

Lambda:

- Lambda API is reachable and reports one active `enel-splat` instance.
- Instance: A100-SXM4-40GB in `us-east-1`, idle at preflight.
- Remote disk: about 464 GB free under `/home/ubuntu`.
- Remote tools: `colmap`, `ffmpeg`, `torch`, `gsplat`, `numpy`, and `PIL`.
- Remote COLMAP is `3.7 ... without CUDA`; GPU SIFT is not available with the
  current apt package.

Dry run:

- Staged input:
  `video_to_gaussian_splat/workspaces/exp_multifeed_preflight/input`.
- Frame/QC dry run workspace:
  `video_to_gaussian_splat/workspaces/job-20260511T001624Z`.
- Selected 86 frames total:
  - `cam1`: 14 selected from 22 extracted.
  - `cam2`: 72 selected from 105 extracted.
- Dry-run frame workspace size: 2.3 MB.

## Test Matrix

Run all variants on the same warm instance and the same source input whenever
possible.

### A. Current Baseline

Use the existing pipeline unchanged except for the headless COLMAP fix:

```bash
cd video_to_gaussian_splat
set -a && source .env && set +a
.venv/bin/splat run workspaces/exp_multifeed_preflight/input \
  --job-id exp-a-current \
  --frames-per-cam 120 \
  --sample-fps 4 \
  --max-steps 7000 \
  --keep-warm
```

Purpose: measure current end-to-end time and quality.

### B. Preview Budget

Use fewer frames and fewer training steps:

```bash
cd video_to_gaussian_splat
set -a && source .env && set +a
.venv/bin/splat run workspaces/exp_multifeed_preflight/input \
  --job-id exp-b-preview \
  --frames-per-cam 40 \
  --sample-fps 4 \
  --max-steps 2000 \
  --keep-warm
```

Purpose: find the fastest acceptable preview using current SfM behavior.

### C. Synchronized Keyframes And Pair List

Implement a new experimental SfM mode before running this variant:

- Extract the same timestamp buckets for every camera.
- Name images with camera and timestamp index, for example
  `cam1__t000040.jpg`.
- Generate `pairs.txt` with:
  - `camA__tNNNN camB__tNNNN` for same timestamp cross-camera pairs.
  - `camX__tNNNN camX__tNNNN+1` and `+2` for temporal continuity.
  - `camA__tNNNN camB__tNNNN+1` for small sync drift.
- Replace exhaustive matching with:

```bash
colmap matches_importer \
  --database_path "$DB" \
  --match_list_path "$JOB_DIR/pairs.txt" \
  --match_type pairs \
  --SiftMatching.use_gpu 0
```

Purpose: reduce pair count from O(N^2) to O(cameras * timestamps) while keeping
the important multi-view constraints.

### D. Faster Feature Matching Fallback

Only run this if C is still SfM-bound:

- Use SuperPoint/LightGlue through hloc for feature extraction and matching.
- Import poses/sparse model into the same gsplat training stage.

Purpose: replace CPU SIFT matching if COLMAP remains the bottleneck.

## Metrics To Capture

For every run, record:

- Total wall clock.
- Local frame extraction time.
- Selected frame count per camera.
- Upload tarball size.
- Remote SfM feature extraction, matching, and mapping time.
- `colmap model_analyzer` output:
  - cameras
  - images
  - registered images
  - points
  - observations
  - mean reprojection error
- Training time and final point count.
- Viewer sanity check: loads, approximate shape, major artifacts.

## Decision Criteria

- If B is under 5 minutes and visually acceptable, ship a preview profile first.
- If C cuts SfM time by at least 50% versus A without reducing registered-image
  ratio by more than 10%, implement constrained matching in the main pipeline.
- If C fails because the current clips have too little overlap, repeat with a
  synchronized capture of at least 30 seconds from two or more cameras.
- If SfM remains the bottleneck after C, test hloc/LightGlue or a CUDA-enabled
  COLMAP image.

## Productization Tasks If The Experiment Wins

- Add a CLI/UI preview profile: low frame budget, 2000 training steps, keep warm.
- Add input filtering so `all_cams_combined.mp4` and duplicate normalized/raw
  variants are not accidentally treated as extra cameras.
- Persist per-frame timestamp metadata from extraction.
- Add synchronized keyframe selection.
- Add `pairs.txt` generation and a pair-list SfM mode.
- Emit structured timing metrics for each pipeline stage.
