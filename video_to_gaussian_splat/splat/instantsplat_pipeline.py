"""MASt3R + InstantSplat pipeline: staged multi-feed videos -> Lambda GPU -> splat."""

from __future__ import annotations

import importlib.resources as ires
import json
import logging
import shlex
import shutil
import time
from pathlib import Path
from typing import Sequence

from .config import InstantSplatPipelineConfig, collect_api_env
from .lambda_cloud import LambdaCloudClient, SshRunner, provision, terminate
from .log import event
from .multiview import (
    prepare_concatenated_multiview_inputs,
    stage_synchronized_keyframes_from_sources,
)
from .packaging import package_directory

log = logging.getLogger(__name__)


def run(input_paths: Sequence[Path], cfg: InstantSplatPipelineConfig) -> dict:
    """Run the MASt3R + InstantSplat sparse-view pipeline."""
    started = time.time()
    work = cfg.workspace
    work.mkdir(parents=True, exist_ok=True)
    (work / "config.json").write_text(json.dumps(cfg.to_dict(), indent=2))

    resolved_inputs = [p.expanduser().resolve() for p in input_paths]
    event("instantsplat.start", job_id=cfg.job_id, inputs=[str(p) for p in resolved_inputs])

    # ---- 1. Local: concatenate feed segments and stage sparse synchronized views.
    for generated_dir in (work / "feeds", work / "job", work / "upload"):
        if generated_dir.exists():
            shutil.rmtree(generated_dir)
    feeds = prepare_concatenated_multiview_inputs(
        resolved_inputs,
        work / "feeds",
    )
    feed_count = len(feeds.sources)
    if feed_count < 2:
        raise RuntimeError("InstantSplat path needs at least 2 video feeds")

    timestamps = max(1, cfg.instantsplat.timestamps_per_feed)
    if cfg.instantsplat.max_images > 0:
        timestamps = min(timestamps, max(1, cfg.instantsplat.max_images // feed_count))

    stage_dir = work / "job"
    manifest = stage_synchronized_keyframes_from_sources(
        feeds.sources,
        input_dir=feeds.directory,
        output_dir=stage_dir,
        timestamps=timestamps,
        long_edge_px=cfg.instantsplat.long_edge_px,
        temporal_neighbors=cfg.instantsplat.temporal_neighbors,
        cross_view_drift=cfg.instantsplat.cross_view_drift,
    )
    image_count = int(manifest["image_count"])
    if image_count < 2:
        raise RuntimeError(f"only {image_count} staged images; need at least 2")

    # ---- 2. Local: package staged job.
    tarball, sha = package_directory(stage_dir, work / "upload" / f"{cfg.job_id}.tar.gz")

    # ---- 3. Cloud: provision + bootstrap.
    if not cfg.lambda_.api_key:
        raise RuntimeError(
            "No Lambda API key. Set LAMBDA_API_KEY, write video_to_gaussian_splat/.env, "
            "or write ~/.enel/lambda.key"
        )
    client = LambdaCloudClient(cfg.lambda_.api_key)
    instance = provision(client, cfg.lambda_)
    instance_id = instance["id"]
    event(
        "instance.ready",
        id=instance_id,
        ip=instance["ip"],
        type=instance.get("instance_type", {}).get("name"),
    )

    runner = SshRunner(
        host=instance["ip"],
        user=cfg.lambda_.ssh_user,
        identity_file=cfg.lambda_.ssh_private_key,
    )

    try:
        runner.wait_for_ssh(timeout=900.0)
        _push_remote_assets(runner, cfg)
        bootstrap_env = {
            "INSTANTSPLAT_REPO_URL": cfg.instantsplat.repo_url,
            "INSTANTSPLAT_REPO_REF": cfg.instantsplat.repo_ref,
            "MAST3R_CHECKPOINT_URL": cfg.instantsplat.mast3r_checkpoint_url,
            **collect_api_env(cfg.instantsplat.forward_api_keys),
        }
        rc = runner.run_detached(
            f"{_env_prefix(bootstrap_env)} bash "
            f"{shlex.quote(cfg.remote_root)}/bin/bootstrap_instantsplat.sh "
            f"{shlex.quote(cfg.remote_root)}",
            log_path=f"{cfg.remote_root}/bootstrap_instantsplat.log",
            pid_path=f"{cfg.remote_root}/bootstrap_instantsplat.pid",
            done_path=f"{cfg.remote_root}/bootstrap_instantsplat.done",
            max_silence=2400.0,
            display_command=(
                f"{_env_prefix_redacted(bootstrap_env)} bash "
                f"{shlex.quote(cfg.remote_root)}/bin/bootstrap_instantsplat.sh "
                f"{shlex.quote(cfg.remote_root)}"
            ),
        )
        if rc != 0:
            raise RuntimeError(f"InstantSplat bootstrap failed (rc={rc})")

        # ---- 4. Upload staged images.
        remote_job = f"{cfg.remote_root}/jobs/{cfg.job_id}"
        runner.run(f"rm -rf {shlex.quote(remote_job)} && mkdir -p {shlex.quote(remote_job)}")
        runner.upload(tarball, f"{remote_job}/{tarball.name}")
        runner.run(
            f"cd {shlex.quote(remote_job)} && "
            f"tar -I pigz -xf {shlex.quote(tarball.name)} && rm {shlex.quote(tarball.name)}"
        )

        # ---- 5. Run MASt3R geometry + InstantSplat train.
        rc = runner.run_detached(
            f"bash {shlex.quote(cfg.remote_root)}/bin/run_instantsplat.sh "
            f"{shlex.quote(cfg.remote_root)} "
            f"{shlex.quote(remote_job)} "
            f"{cfg.instantsplat.train_iterations} "
            f"{cfg.instantsplat.image_size} "
            f"{1 if cfg.instantsplat.render_video else 0}",
            log_path=f"{remote_job}/run_instantsplat.log",
            pid_path=f"{remote_job}/run_instantsplat.pid",
            done_path=f"{remote_job}/run_instantsplat.done",
            max_silence=2400.0,
        )
        if rc != 0:
            raise RuntimeError(f"InstantSplat run failed (rc={rc})")

        # ---- 6. Export viewer-ready .splat.
        export_cmd = (
            f"source {shlex.quote(cfg.remote_root)}/instantsplat-venv/bin/activate && "
            f"python {shlex.quote(cfg.remote_root)}/bin/export_splat.py "
            f"--ply {shlex.quote(remote_job)}/result/point_cloud.ply "
            f"--out {shlex.quote(remote_job)}/result/scene.splat"
        )
        rc = runner.run_streaming(export_cmd)
        if rc != 0:
            raise RuntimeError(f"InstantSplat export failed (rc={rc})")

        # ---- 7. Download artifacts.
        out_dir = work / "result"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        downloaded_artifacts = _download_viewer_artifacts(runner, remote_job, out_dir)
    finally:
        if not cfg.lambda_.keep_warm:
            log.info("terminating instance %s", instance_id)
            terminate(client, instance_id)

    elapsed = time.time() - started
    summary = {
        "ok": True,
        "job_id": cfg.job_id,
        "pipeline": "mast3r-instantsplat",
        "elapsed_s": elapsed,
        "feed_count": feed_count,
        "timestamps_per_feed": timestamps,
        "image_count": image_count,
        "tarball_sha256": sha,
        "instance_id": instance_id,
        "splat_path": str((work / "result" / "scene.splat").resolve()),
        "downloaded_artifacts": downloaded_artifacts,
    }
    (work / "result.json").write_text(json.dumps(summary, indent=2))
    event("instantsplat.done", **{k: v for k, v in summary.items() if k != "ok"})
    return summary


def _download_viewer_artifacts(runner: SshRunner, remote_job: str, out_dir: Path) -> list[str]:
    artifacts = [
        "scene.splat",
        "cameras.json",
        "training_log.json",
        "01_init_geo.log",
        "02_train.log",
    ]
    downloaded: list[str] = []
    for rel in artifacts:
        local_path = out_dir / rel
        local_path.parent.mkdir(parents=True, exist_ok=True)
        runner.download(f"{remote_job}/result/{rel}", local_path)
        downloaded.append(rel)
    return downloaded


def _push_remote_assets(runner: SshRunner, cfg: InstantSplatPipelineConfig) -> None:
    runner.run(f"mkdir -p {shlex.quote(cfg.remote_root)}/bin")
    with ires.as_file(ires.files("splat.lambda_cloud").joinpath("bootstrap_instantsplat.sh")) as p:
        runner.upload(p, f"{cfg.remote_root}/bin/bootstrap_instantsplat.sh")
    for name in ("run_instantsplat.sh", "export_splat.py"):
        with ires.as_file(ires.files("splat.remote").joinpath(name)) as p:
            runner.upload(p, f"{cfg.remote_root}/bin/{name}")
    runner.run(f"chmod +x {shlex.quote(cfg.remote_root)}/bin/*.sh")


def _env_prefix(env: dict[str, str]) -> str:
    if not env:
        return "env"
    return "env " + " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())


def _env_prefix_redacted(env: dict[str, str]) -> str:
    if not env:
        return "env"
    return "env " + " ".join(f"{key}=***" for key in env)
