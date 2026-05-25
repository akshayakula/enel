"""`splat` CLI."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .config import (
    FrameConfig,
    InstantSplatConfig,
    InstantSplatPipelineConfig,
    LambdaConfig,
    PipelineConfig,
    TrainingConfig,
    load_lambda_key,
)
from .log import setup as setup_logging


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="splat",
        description="Drone video → 3D Gaussian Splat pipeline using Lambda Cloud GPUs.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="Run the full pipeline end-to-end.")
    run.add_argument("input", type=Path,
                     help="Path to a single video, or a directory of videos / cam subdirs.")
    run.add_argument("--workspace", type=Path, default=None,
                     help="Workspace dir (default: video_to_gaussian_splat/workspaces/<job-id>).")
    run.add_argument("--job-id", default=None, help="Override job id (default: timestamp).")
    run.add_argument("--max-steps", type=int, default=7000)
    run.add_argument("--frames-per-cam", type=int, default=120)
    run.add_argument("--sample-fps", type=float, default=4.0)
    run.add_argument("--instance-type", default="gpu_1x_h100_pcie")
    run.add_argument("--region", default=None)
    run.add_argument("--ssh-key-name", default=None,
                     help="Lambda-registered SSH key name (default: first available).")
    run.add_argument("--ssh-private-key", default=None,
                     help="Local private key path. Default: ssh agent / ~/.ssh/id_*.")
    run.add_argument("--keep-warm", action="store_true",
                     help="Don't terminate the instance on completion.")
    run.add_argument("--no-reuse", action="store_true",
                     help="Always launch a fresh instance (default: reuse warm tagged ones).")

    inst = sub.add_parser(
        "mast3r-instantsplat",
        aliases=["instantsplat"],
        help="Run sparse synchronized feeds through MASt3R + InstantSplat on Lambda.",
    )
    inst.add_argument(
        "input",
        nargs="+",
        type=Path,
        help="One or more video files/directories. Camera subdirs are concatenated per feed.",
    )
    inst.add_argument("--workspace", type=Path, default=None,
                      help="Workspace dir (default: video_to_gaussian_splat/workspaces/<job-id>).")
    inst.add_argument("--job-id", default=None, help="Override job id (default: timestamp).")
    inst.add_argument("--iterations", type=int, default=1000,
                      help="InstantSplat Gaussian optimization iterations.")
    inst.add_argument("--timestamps-per-feed", type=int, default=2,
                      help="Synchronized timestamps to sample from each feed.")
    inst.add_argument("--max-images", type=int, default=12,
                      help="Cap total MASt3R/InstantSplat input images; 0 disables the cap.")
    inst.add_argument("--long-edge", type=int, default=960,
                      help="Resize staged source frames to this long edge before upload.")
    inst.add_argument("--image-size", type=int, default=512,
                      help="MASt3R inference image size.")
    inst.add_argument("--temporal-neighbors", type=int, default=1,
                      help="Pair-list metadata only: connect each timestamp to this many later frames.")
    inst.add_argument("--cross-view-drift", type=int, default=0,
                      help="Pair-list metadata only: connect neighboring timestamp buckets across feeds.")
    inst.add_argument("--render-video", action="store_true",
                      help="Also run InstantSplat render.py after training.")
    inst.add_argument("--repo-url", default="https://github.com/NVlabs/InstantSplat.git")
    inst.add_argument("--repo-ref", default="main")
    inst.add_argument(
        "--mast3r-checkpoint-url",
        default=InstantSplatConfig.mast3r_checkpoint_url,
    )
    inst.add_argument("--forward-api-key", action="append", default=[],
                      help="Forward an additional local env var to the remote bootstrap command.")
    inst.add_argument("--instance-type", default="gpu_1x_h100_pcie")
    inst.add_argument("--region", default=None)
    inst.add_argument("--ssh-key-name", default=None,
                      help="Lambda-registered SSH key name (default: first available).")
    inst.add_argument("--ssh-private-key", default=None,
                      help="Local private key path. Default: ssh agent / ~/.ssh/id_*.")
    inst.add_argument("--keep-warm", action="store_true",
                      help="Don't terminate the instance on completion.")
    inst.add_argument("--no-reuse", action="store_true",
                      help="Always launch a fresh instance (default: reuse warm tagged ones).")

    sub.add_parser("frames-only", help="Run only the local frame-extraction + QC step.").add_argument(
        "input", type=Path,
    )

    mv = sub.add_parser(
        "multiview-stage",
        help="Stage synchronized multi-camera keyframes and COLMAP match pairs.",
    )
    mv.add_argument("input", type=Path, help="Directory containing one video per camera.")
    mv.add_argument("output", type=Path, help="Output job dir containing images/ and pairs.txt.")
    mv.add_argument("--timestamps", type=int, default=40,
                    help="Number of synchronized timestamp buckets to extract.")
    mv.add_argument("--long-edge", type=int, default=960,
                    help="Resize extracted frames so the long edge is this many pixels.")
    mv.add_argument("--temporal-neighbors", type=int, default=2,
                    help="Within each camera, match each timestamp to this many future timestamps.")
    mv.add_argument("--cross-view-drift", type=int, default=1,
                    help="Across cameras, also match +/- this many timestamp buckets.")
    mv.add_argument("--include-raw-when-normalized-exists", action="store_true",
                    help="Prefer raw videos instead of *_normalized.mp4 convenience exports.")

    info = sub.add_parser("ping-lambda", help="Verify Lambda Cloud credentials.")
    info.add_argument("--list-types", action="store_true",
                      help="Print available instance types with capacity.")

    matrix = sub.add_parser(
        "experiment-matrix",
        help="List valid combinations of input, geometry, refinement, and cleanup stages.",
    )
    matrix.add_argument("--format", choices=("markdown", "json", "csv"), default="markdown")
    matrix.add_argument("--include-invalid", action="store_true",
                        help="Include invalid Cartesian-product rows with the reason they fail.")
    matrix.add_argument("--runnable-only", action="store_true",
                        help="Only show combinations implemented by the current code.")
    matrix.add_argument("--catalog", action="store_true",
                        help="Print the stage catalog instead of combinations.")
    matrix.add_argument("--ranked", action="store_true",
                        help="Rank valid combinations by near-term experimental value.")
    matrix.add_argument("--limit", type=int, default=None,
                        help="Limit rows after filtering/ranking.")

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "ping-lambda":
        return _cmd_ping(args)
    if args.cmd == "frames-only":
        return _cmd_frames_only(args)
    if args.cmd == "multiview-stage":
        return _cmd_multiview_stage(args)
    if args.cmd == "experiment-matrix":
        return _cmd_experiment_matrix(args)
    if args.cmd in {"mast3r-instantsplat", "instantsplat"}:
        return _cmd_mast3r_instantsplat(args)
    if args.cmd == "run":
        return _cmd_run(args)
    return 2


def _cmd_ping(args: argparse.Namespace) -> int:
    from .lambda_cloud import LambdaCloudClient

    key = load_lambda_key()
    if not key:
        print("No Lambda API key. Set LAMBDA_API_KEY or write ~/.enel/lambda.key.",
              file=sys.stderr)
        return 1
    client = LambdaCloudClient(key)
    try:
        instances = client.list_instances()
    except Exception as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print(f"OK — {len(instances)} active/pending instances")
    if args.list_types:
        types = client.list_instance_types()
        rows = []
        for name, entry in sorted(types.items()):
            regions = [r["name"] for r in entry.get("regions_with_capacity_available", [])]
            if regions:
                rows.append((name, ",".join(regions)))
        for name, regions in rows:
            print(f"  {name:30s} -> {regions}")
        if not rows:
            print("  (no capacity in any region right now)")
    return 0


def _cmd_frames_only(args: argparse.Namespace) -> int:
    from .frames import discover_cameras, extract_and_select

    job_id = _now_id()
    work = _default_workspace(job_id)
    setup_logging(work)
    cfg = FrameConfig()
    cams = discover_cameras(args.input.resolve())
    out = extract_and_select(cams, work / "extracted_frames", cfg)
    print(json.dumps({"frames": len(out), "workspace": str(work)}, indent=2))
    return 0


def _cmd_multiview_stage(args: argparse.Namespace) -> int:
    from .multiview import stage_synchronized_keyframes

    manifest = stage_synchronized_keyframes(
        args.input.resolve(),
        args.output.resolve(),
        timestamps=args.timestamps,
        long_edge_px=args.long_edge,
        temporal_neighbors=args.temporal_neighbors,
        cross_view_drift=args.cross_view_drift,
        prefer_normalized=not args.include_raw_when_normalized_exists,
    )
    print(json.dumps(manifest, indent=2))
    return 0


def _cmd_experiment_matrix(args: argparse.Namespace) -> int:
    from .experiment_matrix import (
        enumerate_combinations,
        option_catalog,
        rank_combinations,
        render_matrix,
    )

    if args.catalog:
        print(json.dumps(option_catalog(), indent=2))
        return 0
    rows = enumerate_combinations(include_invalid=args.include_invalid)
    if args.runnable_only:
        rows = [row for row in rows if row.runnable_now]
    if args.ranked:
        rows = rank_combinations(rows)
    if args.limit is not None:
        rows = rows[:max(0, args.limit)]
    rendered = render_matrix(rows, fmt=args.format)
    sys.stdout.write(rendered)
    if not rendered.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    from .pipeline import run

    job_id = args.job_id or _now_id()
    work = (args.workspace or _default_workspace(job_id)).resolve()
    setup_logging(work)

    key = load_lambda_key()
    if not key:
        print("No Lambda API key. Set LAMBDA_API_KEY or write ~/.enel/lambda.key.",
              file=sys.stderr)
        return 1

    cfg = PipelineConfig(
        workspace=work,
        job_id=job_id,
        frames=FrameConfig(target_per_camera=args.frames_per_cam, sample_fps=args.sample_fps),
        training=TrainingConfig(max_steps=args.max_steps, save_steps=args.max_steps),
        lambda_=LambdaConfig(
            api_key=key,
            instance_type=args.instance_type,
            region=args.region,
            ssh_key_name=args.ssh_key_name,
            ssh_private_key=args.ssh_private_key,
            keep_warm=args.keep_warm,
            reuse_running=not args.no_reuse,
        ),
    )

    try:
        result = run(args.input.resolve(), cfg)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "workspace": str(work)},
                         indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


def _cmd_mast3r_instantsplat(args: argparse.Namespace) -> int:
    from .instantsplat_pipeline import run

    job_id = args.job_id or _now_id()
    work = (args.workspace or _default_workspace(job_id)).resolve()
    setup_logging(work)

    key = load_lambda_key()
    if not key:
        print(
            "No Lambda API key. Set LAMBDA_API_KEY, write video_to_gaussian_splat/.env, "
            "or write ~/.enel/lambda.key.",
            file=sys.stderr,
        )
        return 1

    forward_keys = tuple(dict.fromkeys((
        *InstantSplatConfig().forward_api_keys,
        *args.forward_api_key,
    )))
    cfg = InstantSplatPipelineConfig(
        workspace=work,
        job_id=job_id,
        instantsplat=InstantSplatConfig(
            repo_url=args.repo_url,
            repo_ref=args.repo_ref,
            mast3r_checkpoint_url=args.mast3r_checkpoint_url,
            train_iterations=args.iterations,
            image_size=args.image_size,
            timestamps_per_feed=args.timestamps_per_feed,
            max_images=args.max_images,
            long_edge_px=args.long_edge,
            temporal_neighbors=args.temporal_neighbors,
            cross_view_drift=args.cross_view_drift,
            render_video=args.render_video,
            forward_api_keys=forward_keys,
        ),
        lambda_=LambdaConfig(
            api_key=key,
            instance_type=args.instance_type,
            region=args.region,
            ssh_key_name=args.ssh_key_name,
            ssh_private_key=args.ssh_private_key,
            keep_warm=args.keep_warm,
            reuse_running=not args.no_reuse,
            tag="enel-instantsplat",
        ),
    )

    try:
        result = run([p.resolve() for p in args.input], cfg)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "workspace": str(work)},
                         indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


def _now_id() -> str:
    return time.strftime("job-%Y%m%dT%H%M%SZ", time.gmtime())


def _default_workspace(job_id: str) -> Path:
    return Path(__file__).resolve().parent.parent / "workspaces" / job_id


if __name__ == "__main__":
    raise SystemExit(main())
