# Video To Gaussian Splat

This folder is a staging pipeline for:

1. Recorded camera videos
2. Frame extraction
3. Frame quality control / pruning
4. COLMAP-ready image dataset
5. Later Gaussian Splat training

The main goal is to reduce COLMAP time by keeping only frames that are:

- sharp
- reasonably exposed
- not too redundant
- spread through time

## Suggested workflow

Put your source videos into a workspace folder, for example:

```text
video_to_gaussian_splat/workspaces/living_room/raw_videos/
```

Example filenames:

```text
cam1.mp4
cam2.mp4
cam3.mp4
cam4.mp4
```

Extract frames at a low rate first:

```bash
python3 video_to_gaussian_splat/extract_frames.py \
  --input-dir video_to_gaussian_splat/workspaces/living_room/raw_videos \
  --output-dir video_to_gaussian_splat/workspaces/living_room/extracted_frames \
  --fps 1
```

Then run QC and build a smaller COLMAP image set:

```bash
python3 video_to_gaussian_splat/qc_select_frames.py \
  --input-dir video_to_gaussian_splat/workspaces/living_room/extracted_frames \
  --output-dir video_to_gaussian_splat/workspaces/living_room/colmap_dataset/images \
  --report-path video_to_gaussian_splat/workspaces/living_room/qc_report.csv \
  --bucket-size 5 \
  --top-k-per-video 120
```

This produces a single image folder that is ready to feed into COLMAP.

## Runpod COLMAP

There is also a Runpod-oriented script:

```bash
./video_to_gaussian_splat/runpod_colmap.sh \
  --images video_to_gaussian_splat/workspaces/living_room/colmap_dataset/images \
  --workspace video_to_gaussian_splat/workspaces/living_room/colmap_workspace
```

What it does:

- groups flat images like `cam1_0001.jpg` into per-camera folders
- tells COLMAP to share intrinsics per folder with `single_camera_per_folder`
- runs feature extraction, matching, and sparse mapping

Optional dense reconstruction:

```bash
./video_to_gaussian_splat/runpod_colmap.sh \
  --images video_to_gaussian_splat/workspaces/living_room/colmap_dataset/images \
  --workspace video_to_gaussian_splat/workspaces/living_room/colmap_workspace \
  --dense
```

Matcher options:

- default: `--matcher exhaustive`
- alternatives: `--matcher sequential` or `--matcher vocab_tree`

For `vocab_tree`, set:

```bash
export COLMAP_VOCAB_TREE_PATH=/path/to/vocab_tree_flickr100K_words256K.bin
```

Recommended first pass on Runpod:

- use the QC-selected image folder
- keep image count modest
- start with sparse reconstruction only
- add `--dense` only after the sparse model looks sane

## Why this helps

COLMAP is usually slowed down by:

- too many nearly identical frames
- blurry frames
- low-texture or poorly exposed frames

This pipeline aggressively reduces redundancy before reconstruction.

## Practical defaults

- Start with `--fps 1`
- Start with `--top-k-per-video 60` to `120`
- Increase only after you confirm COLMAP reconstructs reliably

## Output layout

Typical output:

```text
workspaces/living_room/
  raw_videos/
  extracted_frames/
    cam1/
    cam2/
    cam3/
    cam4/
  colmap_dataset/
    images/
  qc_report.csv
```

## Notes

- This step prepares data for COLMAP. It does not run COLMAP itself.
- `colmap` is not currently installed in this local workspace, but `runpod_colmap.sh` is ready for a machine where COLMAP is available.
- The selection heuristic is intentionally simple and robust: sharpness, contrast, exposure, and temporal bucketing.
