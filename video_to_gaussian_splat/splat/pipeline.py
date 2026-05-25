"""End-to-end orchestrator: local frames → upload → SfM → train → download splat."""

from __future__ import annotations

import json
import logging
import shlex
import shutil
import time
from pathlib import Path
from typing import Optional

import importlib.resources as ires

from .config import PipelineConfig
from .frames import discover_cameras, extract_and_select
from .lambda_cloud import LambdaCloudClient, SshRunner, provision, terminate
from .log import event
from .packaging import package_frames

log = logging.getLogger(__name__)


def run(input_path: Path, cfg: PipelineConfig) -> dict:
    """Run the full pipeline. Returns a result dict suitable for JSON encoding.

    The caller is responsible for setting up logging (call splat.log.setup first).
    """
    started = time.time()
    work = cfg.workspace
    work.mkdir(parents=True, exist_ok=True)
    (work / "config.json").write_text(json.dumps(cfg.to_dict(), indent=2))

    # ---- 1. Local: extract + QC --------------------------------------------
    event("pipeline.start", job_id=cfg.job_id, input=str(input_path))
    cameras = discover_cameras(input_path)
    event("input.discovered", cameras=[c.cam_id for c in cameras])

    frames_root = work / "extracted_frames"
    selected = extract_and_select(cameras, frames_root, cfg.frames)
    if len(selected) < 12:
        raise RuntimeError(
            f"only {len(selected)} usable frames after QC — need at least ~12 for SfM"
        )

    # ---- 2. Local: package -------------------------------------------------
    tarball, sha = package_frames(frames_root, work / "upload" / f"{cfg.job_id}.tar.gz")

    # ---- 3. Cloud: provision + bootstrap -----------------------------------
    if not cfg.lambda_.api_key:
        raise RuntimeError(
            "No Lambda API key. Set LAMBDA_API_KEY or write ~/.enel/lambda.key"
        )
    client = LambdaCloudClient(cfg.lambda_.api_key)
    instance = provision(client, cfg.lambda_)
    instance_id = instance["id"]
    event("instance.ready", id=instance_id, ip=instance["ip"], type=instance.get("instance_type", {}).get("name"))

    runner = SshRunner(
        host=instance["ip"],
        user=cfg.lambda_.ssh_user,
        identity_file=cfg.lambda_.ssh_private_key,
    )

    try:
        runner.wait_for_ssh(timeout=900.0)
        # ---- 4. Bootstrap (idempotent, detached so SSH drops are harmless) -
        _push_remote_assets(runner, cfg)
        rc = runner.run_detached(
            f"bash {shlex.quote(cfg.remote_root)}/bin/bootstrap.sh "
            f"{shlex.quote(cfg.remote_root)}",
            log_path=f"{cfg.remote_root}/bootstrap.log",
            pid_path=f"{cfg.remote_root}/bootstrap.pid",
            done_path=f"{cfg.remote_root}/bootstrap.done",
            max_silence=1800.0,  # 30 min — covers gsplat CUDA-kernel build
        )
        if rc != 0:
            raise RuntimeError(f"bootstrap failed (rc={rc})")

        # ---- 5. Upload tarball + extract -----------------------------------
        remote_job = f"{cfg.remote_root}/jobs/{cfg.job_id}"
        runner.run(f"mkdir -p {shlex.quote(remote_job)}")
        runner.upload(tarball, f"{remote_job}/{tarball.name}")
        runner.run(
            f"cd {shlex.quote(remote_job)} && "
            f"tar -I pigz -xf {shlex.quote(tarball.name)} && rm {shlex.quote(tarball.name)}"
        )

        # ---- 6. SfM --------------------------------------------------------
        rc = runner.run_streaming(
            f"bash {shlex.quote(cfg.remote_root)}/bin/run_sfm.sh "
            f"{shlex.quote(remote_job)}"
        )
        if rc != 0:
            raise RuntimeError(f"SfM failed (rc={rc})")

        # ---- 7. Train (detached) -------------------------------------------
        train_cmd = (
            f"source {shlex.quote(cfg.remote_root)}/venv/bin/activate && "
            f"python {shlex.quote(cfg.remote_root)}/bin/run_train.py "
            f"--data-dir {shlex.quote(remote_job)} "
            f"--result-dir {shlex.quote(remote_job)}/result "
            f"--max-steps {cfg.training.max_steps} "
            f"--sh-degree {cfg.training.sh_degree} "
            f"--init-pts {cfg.training.init_num_pts} "
            f"--save-steps {cfg.training.save_steps}"
        )
        rc = runner.run_detached(
            train_cmd,
            log_path=f"{remote_job}/train.log",
            pid_path=f"{remote_job}/train.pid",
            done_path=f"{remote_job}/train.done",
            max_silence=1200.0,
        )
        if rc != 0:
            raise RuntimeError(f"training failed (rc={rc})")

        # ---- 8. Export .splat ---------------------------------------------
        export_cmd = (
            f"source {shlex.quote(cfg.remote_root)}/venv/bin/activate && "
            f"python {shlex.quote(cfg.remote_root)}/bin/export_splat.py "
            f"--ply {shlex.quote(remote_job)}/result/point_cloud.ply "
            f"--out {shlex.quote(remote_job)}/result/scene.splat"
        )
        rc = runner.run_streaming(export_cmd)
        if rc != 0:
            raise RuntimeError(f"export failed (rc={rc})")

        # ---- 9. Download artifacts ----------------------------------------
        out_dir = work / "result"
        out_dir.mkdir(parents=True, exist_ok=True)
        runner.download(f"{remote_job}/result/scene.splat", out_dir / "scene.splat")
        runner.download(f"{remote_job}/result/point_cloud.ply", out_dir / "point_cloud.ply")
        runner.download(f"{remote_job}/result/training_log.json",
                        out_dir / "training_log.json")
    finally:
        if not cfg.lambda_.keep_warm:
            log.info("terminating instance %s", instance_id)
            terminate(client, instance_id)

    elapsed = time.time() - started
    summary = {
        "ok": True,
        "job_id": cfg.job_id,
        "elapsed_s": elapsed,
        "frames_used": len(selected),
        "splat_path": str((work / "result" / "scene.splat").resolve()),
        "ply_path": str((work / "result" / "point_cloud.ply").resolve()),
        "tarball_sha256": sha,
        "instance_id": instance_id,
    }
    (work / "result.json").write_text(json.dumps(summary, indent=2))
    event("pipeline.done", **{k: v for k, v in summary.items() if k != "ok"})
    return summary


def _push_remote_assets(runner: SshRunner, cfg: PipelineConfig) -> None:
    """Copy bootstrap.sh + remote/ scripts to the instance under <remote_root>/bin/."""
    runner.run(f"mkdir -p {shlex.quote(cfg.remote_root)}/bin")
    with ires.as_file(ires.files("splat.lambda_cloud").joinpath("bootstrap.sh")) as p:
        runner.upload(p, f"{cfg.remote_root}/bin/bootstrap.sh")
    for name in ("run_sfm.sh", "run_train.py", "export_splat.py"):
        with ires.as_file(ires.files("splat.remote").joinpath(name)) as p:
            runner.upload(p, f"{cfg.remote_root}/bin/{name}")
    runner.run(f"chmod +x {shlex.quote(cfg.remote_root)}/bin/*.sh")
