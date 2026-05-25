# 3DGS Experiment Plan

This folder tracks the reconstruction pipelines we will test before changing the
main product path. The immediate goal is a quick interior splat preview from
multiple video feeds, with a slower faithful reconstruction kept as the fallback.

## Pipeline Candidates

### 1. Fast Classic Preview

Purpose: establish the fastest useful baseline with the code we already have.

Flow:

```text
multi-camera videos
-> local frame extraction / QC
-> COLMAP SfM
-> short gsplat training, 1000-3000 steps
-> .splat export
```

What we vary:

- `--frames-per-cam`: 20, 40, 80.
- `--sample-fps`: 2, 4.
- `--max-steps`: 1000, 2000, 3000.
- image long edge: 640, 960, 1280.

Success criteria:

- Under 5 minutes on a warm GPU instance.
- Viewer opens with recognizable room geometry.
- COLMAP registers at least 60% of selected frames.

### 2. Synchronized Multi-View Pair List

Purpose: use multiple feeds as constraints instead of treating every frame as an
unordered photo.

Flow:

```text
multi-camera videos
-> synchronized timestamp keyframes
-> sparse COLMAP pairs.txt
-> COLMAP feature extraction + matches_importer
-> mapper
-> short gsplat training
```

The experimental command is:

```bash
cd video_to_gaussian_splat
.venv/bin/splat multiview-stage \
  ../exports/compiled/2026-04-19T17-48-36-433Z \
  workspaces/exp-sync-pairs/job \
  --timestamps 40 \
  --long-edge 960 \
  --temporal-neighbors 2 \
  --cross-view-drift 1
```

Output:

```text
workspaces/exp-sync-pairs/job/
├── images/
├── pairs.txt
└── manifest.json
```

Pair rules:

- Same timestamp across cameras.
- Adjacent timestamps within each camera.
- Optional cross-camera `t +/- 1` drift pairs.

Why this matters: for `C` cameras and `T` timestamp buckets, this keeps matching
near `O(C * T)` instead of exhaustive `O((C * T)^2)`.

### 3. Fixed-Rig Calibration

Purpose: if cameras are physically fixed relative to each other, solve the rig
once and reuse it.

Flow:

```text
one calibration capture
-> estimate camera intrinsics and relative camera extrinsics
-> per-run synchronized keyframes
-> solve only rig trajectory
-> initialize 3DGS from known poses
```

This is likely the biggest product-level speedup if the camera layout is stable.
It also gives us a clean way to reject frames that are not synced or not
overlapping.

### 4. Foundation Geometry Initializer

Purpose: replace slow or fragile SfM with a feed-forward geometry prior.

Candidates to test:

- VGGT-style pose/depth/point-map prediction.
- InstantSplat-style sparse-view SfM-free Gaussian initialization.
- MVSplat / AnySplat / FreeSplatter-style feed-forward Gaussian prediction.

Flow:

```text
8-32 synchronized real views
-> feed-forward pose/depth/point/Gaussian initializer
-> export approximate COLMAP-like poses/points or Gaussians
-> 500-2000 gsplat refinement steps
```

This should be tested after the pair-list baseline, because it adds model and
dependency risk.

### 5. Difix3D+ Cleanup And Distillation

Purpose: improve the visual quality of underconstrained areas after we already
have a coarse splat.

Difix3D+ is not the first geometry source. It is a diffusion cleanup pass:

```text
coarse 3DGS preview
-> render interpolated novel views
-> Difix single-step diffusion cleanup
-> distill cleaned pseudo-views back into 3DGS
-> optionally use Difix as an inference-time enhancer
```

Why it is relevant: NVIDIA's Difix3D+ reports a single-step diffusion model that
cleans artifacts in NeRF/3DGS novel views and distills those cleaned views back
into the 3D representation. That maps directly to our preview-quality problem:
fast geometry first, then diffusion for holes and underconstrained regions.

Risk: diffusion can hallucinate. We should weight real captured views higher
than cleaned pseudo-views and label this path as preview-grade unless validated.

Source: https://research.nvidia.com/labs/toronto-ai/difix3d/

## Data Sources For Interior Multi-View Testing

Use real RGB-D or posed multi-view interiors first; synthetic datasets are useful
for stress tests and ablations.

### Best first choices

- ScanNet: RGB-D video dataset with more than 1500 indoor scans, camera poses,
  reconstructions, and semantic annotations.
  https://www.scan-net.org/
- ScanNet++: high-fidelity indoor scenes with higher-quality RGB captures and
  commodity RGB-D data, useful for novel-view synthesis tests.
  https://github.com/scannetpp/scannetpp
- ARKitScenes: large real-world indoor RGB-D captures from mobile devices, with
  processed data and laser-scanner reference depth.
  https://machinelearning.apple.com/research/arkitscenes
- TUM RGB-D: smaller RGB-D SLAM benchmark with 30 Hz RGB-D sequences and ground
  truth camera poses. Good for quick local debugging.
  https://cvg.cit.tum.de/data/datasets/rgbd-dataset
- 7-Scenes: small tracked Kinect RGB-D indoor sequences with per-frame poses.
  Good for pose/debug tests, less representative of modern phone video.
  https://www.microsoft.com/en-us/research/project/rgb-d-dataset-7-scenes/

### Useful but heavier or more constrained

- Matterport3D / Habitat Matterport: large building-scale indoor scans with
  meshes/textures and panoramic RGB-D views. Good for complete rooms, but access
  and licensing are more involved.
  https://niessner.github.io/Matterport/
  https://matterport.com/habitat-matterport-3d-research-dataset
- Realsee3D: large-scale multi-view RGB-D indoor dataset with real and synthetic
  scenes. Potentially valuable for modern indoor reconstruction experiments.
  https://dataset.realsee.ai/

### Synthetic interiors

- Hypersim: photorealistic synthetic indoor scenes with complete camera and
  geometry labels. Good for controlled evaluation.
  https://github.com/apple/ml-hypersim
- Replica: 18 high-quality indoor scene reconstructions, useful for rendering
  controlled multi-view trajectories.
  https://wijmans.xyz/publication/replica-2019/
- InteriorVerse: photorealistic indoor scene dataset useful for inverse
  rendering-style tests.
  https://interiorverse.github.io/

## Measurement Sheet

For every run, record:

- Input dataset and scene.
- Number of cameras / views.
- Number of synchronized timestamp buckets.
- Number of match pairs.
- Frame extraction time.
- Feature extraction time.
- Matching time.
- Mapping time.
- Registered image count and ratio.
- Sparse point count.
- Mean reprojection error.
- Training steps and training time.
- Final `.splat` size.
- Viewer pass/fail and qualitative notes.

## Enumerating Pipeline Combinations

Pipeline choices are modeled as four axes:

- input/staging
- pose/geometry initialization
- 3DGS refinement
- diffusion cleanup

List every valid combination:

```bash
cd video_to_gaussian_splat
.venv/bin/splat experiment-matrix
```

List only combinations runnable with code that exists today:

```bash
cd video_to_gaussian_splat
.venv/bin/splat experiment-matrix --runnable-only
```

Export machine-readable matrices:

```bash
cd video_to_gaussian_splat
.venv/bin/splat experiment-matrix --format json
.venv/bin/splat experiment-matrix --format csv
```

Audit the full Cartesian product, including invalid combinations and why they
are invalid:

```bash
cd video_to_gaussian_splat
.venv/bin/splat experiment-matrix --include-invalid --format csv
```

Rank every valid combination by near-term experimental value:

```bash
cd video_to_gaussian_splat
.venv/bin/splat experiment-matrix --ranked
.venv/bin/splat experiment-matrix --ranked --limit 20
.venv/bin/splat experiment-matrix --ranked --format csv \
  > experiments/ranked_pipeline_matrix.csv
```

The ranking is a heuristic. It favors near-term readiness, explicit multi-view
structure, faster preview latency, faithful real-view geometry before diffusion,
and lower integration risk.

Current axes:

- input/staging: `classic_topk`, `sync_keyframes`, `fixed_rig_sync`,
  `posed_rgbd_dataset`
- geometry: `colmap_auto`, `colmap_pairs`, `fixed_rig_trajectory`,
  `vggt_geometry`, `instantsplat_init`, `feedforward_gs`, `posed_depth_init`
- refinement: `none`, `gsplat_1k`, `gsplat_2k`, `gsplat_7k`, `fastgs_100s`
- cleanup: `none`, `difix_inference`, `difix_distill`

Current count: 264 valid combinations out of 420 possible rows. Three are fully
runnable through the current end-to-end path: classic COLMAP with `gsplat_1k`,
`gsplat_2k`, or `gsplat_7k`, all without diffusion cleanup.

Rows marked `implemented` are runnable now through the current end-to-end
pipeline. `partial` rows have some support but need integration work, such as
using synchronized staging output or packaging `pairs.txt` through the normal
upload path. `external` rows require model/framework integration. `planned` rows
need new repo code or calibration/data adapters.

## Next Code Tasks

- Package `pairs.txt` through the normal upload path.
- Add a first-class `--sync-keyframes` / `--match-pairs` run mode.
- Add structured timing events around SfM stages.
- Add a dataset adapter for posed RGB-D image folders.
- Add a smoke test that stages 4-8 timestamps and verifies `pairs.txt` shape.
