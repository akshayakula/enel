# video_to_gaussian_splat

Production-shaped pipeline that turns the project's drone-camera recordings into
a 3D Gaussian Splat using on-demand Lambda Cloud GPUs.

End-to-end flow (`splat run <input>`):

1. **Local frame extraction + QC** — `ffmpeg` per camera, Laplacian-variance +
   exposure scoring, top-K-per-camera selection spread across the timeline.
2. **Tarball + upload** — only the surviving JPEGs (typically <200 MB) are
   shipped, so the GPU clock starts when training starts, not when ffmpeg starts.
3. **Lambda Cloud provisioning** — picks the first H100 region with capacity,
   falls back to A100/A10. Reuses an already-running tagged instance when one
   exists (skips the 2–3 min boot for back-to-back runs).
4. **SfM** — COLMAP feature extraction + (exhaustive ≤400 imgs / sequential)
   matching + mapper, all CUDA-accelerated.
5. **Training** — minimal gsplat trainer (`splat/remote/run_train.py`) with
   `DefaultStrategy` densification, ~7000 steps for a clean preview.
6. **Export** — converts the 3DGS-style `.ply` into the `.splat` binary used by
   antimatter15's web viewer that already ships in this repo
   (`web_rtc_app/public/splat-viewer.html`).
7. **Download + register** — the result lands in
   `video_to_gaussian_splat/workspaces/<job-id>/result/{scene.splat,point_cloud.ply,training_log.json}`,
   reachable from the dashboard at `/splat-workspaces/<job-id>/result/scene.splat`.

The Node dashboard (`web_rtc_app/public/viewer.html`) gets a "Generate Splat
(Lambda)" panel that hits the new `/api/splat/jobs` endpoints, polls status,
and links straight to the splat viewer when done.

## One-time setup

### Lambda Cloud credentials

Any of these works (the orchestrator probes them in order):

```bash
export LAMBDA_API_KEY=secret_xxx...
# or put it in this package's ignored env file
echo "LAMBDA_API_KEY=secret_xxx..." > video_to_gaussian_splat/.env
# or
mkdir -p ~/.enel && echo "secret_xxx..." > ~/.enel/lambda.key
```

You also need an SSH key registered with Lambda whose private half is
loadable by your local `ssh-agent` (or pointed to via `--ssh-private-key
~/.ssh/lambda`). You can verify both at once:

```bash
splat ping-lambda --list-types
```

### Local Python environment

```bash
cd video_to_gaussian_splat
python3 -m venv .venv
.venv/bin/pip install -e .
```

`server.js` looks for `video_to_gaussian_splat/.venv/bin/python` by default.
Override with `SPLAT_PYTHON=/usr/bin/python3` if you want the system interpreter.

## Running

From the dashboard: hit **Generate Splat (latest compiled)**. The button kicks
off the most recent compiled batch under `exports/compiled/<timestamp>/`,
falling back to `recordings/`.

From the CLI:

```bash
.venv/bin/splat run ../recordings           # whole MediaMTX recording tree
.venv/bin/splat run ../exports/compiled/2025-...  # one compiled batch
.venv/bin/splat run /path/to/single/clip.mp4
```

### MASt3R + InstantSplat path

For sparse-view MASt3R geometry initialization plus InstantSplat Gaussian
optimization:

```bash
cd video_to_gaussian_splat
.venv/bin/splat mast3r-instantsplat ../recordings
```

You can pass multiple feed roots/files. Camera subdirectories are treated as
chronological segments and concatenated per camera before sparse synchronized
frames are sampled:

```bash
.venv/bin/splat mast3r-instantsplat \
  ../recordings/cam1 ../recordings/cam2 ../recordings/cam3 \
  --timestamps-per-feed 2 \
  --max-images 12 \
  --iterations 1000
```

The result lands in
`video_to_gaussian_splat/workspaces/<job-id>/result/{scene.splat,point_cloud.ply,training_log.json}`.

The command auto-loads ignored `.env` files before talking to Lambda. If you
need remote downloads that require credentials, set `HF_TOKEN`,
`HUGGINGFACE_HUB_TOKEN`, or `WANDB_API_KEY`; those names are forwarded to the
remote bootstrap command with values redacted from local logs. Add more with
`--forward-api-key SOME_ENV_NAME`.

Useful InstantSplat flags:

| flag | default | notes |
|---|---|---|
| `--timestamps-per-feed` | 2 | Synchronized moments sampled from each feed after per-camera concatenation. |
| `--max-images` | 12 | Caps MASt3R pair count. Set 0 to disable. |
| `--iterations` | 1000 | InstantSplat Gaussian optimization iterations. |
| `--long-edge` | 960 | Local source-frame resize before upload. |
| `--image-size` | 512 | MASt3R inference image size. |
| `--render-video` | off | Also run InstantSplat `render.py`; slower but useful for remote inspection. |

Useful flags:

| flag | default | notes |
|---|---|---|
| `--max-steps` | 7000 | Training steps. ~3 min on H100. Bump to 30000 for the paper-grade splat. |
| `--frames-per-cam` | 120 | Top-K frames retained per camera after QC. |
| `--sample-fps` | 4.0 | ffmpeg sample rate. Higher = slower extract, more candidates. |
| `--instance-type` | `gpu_1x_h100_pcie` | Lambda SKU. Falls back to A100/A10 automatically. |
| `--keep-warm` | off | Skip terminate; reuse on the next run via `tag` matching. |
| `--no-reuse` | off | Force a fresh launch even if a warm one exists. |

## Why these choices

- **Pre-extract frames locally.** We pay $2.50/hr for the H100; we don't pay it
  to wait on ffmpeg. Frames also tarball ~10–50× smaller than the source video.
- **Top-K per camera, time-bucketed.** Top-K alone clusters picks in the sharp
  segments and starves SfM of viewpoint coverage. Bucketing first guarantees
  spread.
- **COLMAP exhaustive ≤400 imgs.** For our typical 4-cam × 120-frame budget
  exhaustive matching beats sequential on accuracy and isn't slower in practice.
- **Idempotent bootstrap.** First call installs colmap/ffmpeg/gsplat (~2 min);
  subsequent calls on the same warm instance skip everything via the `.bootstrap.ok`
  stamp.
- **Slim trainer.** We skip the gsplat example trainer's viser/nerfview/eval
  overhead. The remote venv stays small and a fresh box is workable in <3 min.
- **`.splat` binary export.** The repo already ships antimatter15's web viewer.
  We feed it the format it natively understands so the dashboard can preview a
  result with no extra plumbing.

## Layout

```
video_to_gaussian_splat/
├── splat/
│   ├── cli.py                    # `splat run|frames-only|ping-lambda`
│   ├── pipeline.py               # end-to-end orchestrator
│   ├── frames.py                 # extract + QC
│   ├── packaging.py              # tarball + sha256
│   ├── config.py                 # PipelineConfig / load_lambda_key
│   ├── log.py                    # stderr + events.jsonl
│   ├── lambda_cloud/
│   │   ├── client.py             # REST client
│   │   ├── provisioner.py        # launch / reuse / terminate
│   │   ├── ssh.py                # ssh+scp shell wrapper
│   │   └── bootstrap.sh          # one-shot box bootstrap
│   └── remote/
│       ├── run_sfm.sh            # COLMAP
│       ├── run_train.py          # gsplat trainer
│       └── export_splat.py       # ply → .splat
└── workspaces/<job-id>/
    ├── extracted_frames/<cam>/   # post-QC JPEGs
    ├── upload/<job>.tar.gz       # what we shipped
    ├── events.jsonl              # structured progress
    ├── stdout.log / stderr.log
    ├── result.json               # final manifest
    └── result/{scene.splat,point_cloud.ply,training_log.json}
```
