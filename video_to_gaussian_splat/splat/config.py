"""Pipeline configuration. Knobs that change behaviour live here, not buried in code."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


def _expand(p: str | os.PathLike[str]) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p)))).resolve()


_ENV_LOADED = False


def load_env_files(extra_paths: tuple[Path, ...] = ()) -> None:
    """Load simple KEY=VALUE env files without adding a runtime dotenv dependency."""
    global _ENV_LOADED
    if _ENV_LOADED and not extra_paths:
        return

    package_root = Path(__file__).resolve().parent.parent
    repo_root = package_root.parent
    candidates = (
        *extra_paths,
        Path.cwd() / ".env",
        package_root / ".env",
        repo_root / ".env",
        Path.home() / ".enel" / "env",
    )
    seen: set[Path] = set()
    for candidate in candidates:
        candidate = candidate.expanduser()
        if candidate in seen or not candidate.is_file():
            continue
        seen.add(candidate)
        _load_env_file(candidate)
    if not extra_paths:
        _ENV_LOADED = True


def _load_env_file(path: Path) -> None:
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


@dataclass
class FrameConfig:
    # Target ~N usable frames per camera. Splat training quality plateaus fast;
    # 80–200 sharp frames per cam beats 2000 blurry ones and keeps SfM small.
    target_per_camera: int = 120
    sample_fps: float = 4.0
    min_sharpness: float = 8.0          # Laplacian-variance floor
    min_brightness: float = 25.0        # 0..255
    max_brightness: float = 235.0
    jpeg_quality: int = 92
    long_edge_px: int = 1600            # downscale; H100 + gsplat handles 1600px easily


@dataclass
class TrainingConfig:
    # gsplat trainer knobs. Defaults give a usable preview in ~2-3 min on H100.
    max_steps: int = 7000
    eval_steps: int = 0                 # skip eval to save time
    save_steps: int = 7000
    sh_degree: int = 3
    init_num_pts: int = 100_000
    densify_grad_thresh: float = 0.0002


@dataclass
class LambdaConfig:
    api_key: Optional[str] = None
    # H100 80GB PCIe is the sweet spot: ~$2.49/hr, ample VRAM, plentiful.
    # gpu_1x_h100_pcie is the standard SKU name; gpu_1x_a100 is the fallback.
    instance_type: str = "gpu_1x_h100_pcie"
    fallback_instance_types: tuple[str, ...] = (
        "gpu_1x_h100_sxm5",
        "gpu_1x_a100_sxm4",
        "gpu_1x_a100",
        "gpu_1x_a10",
    )
    region: Optional[str] = None        # let API pick first available
    ssh_key_name: Optional[str] = None  # must already be registered with Lambda
    reuse_running: bool = True          # if an instance with our tag is up, reuse it
    keep_warm: bool = False             # don't terminate on completion (saves boot time)
    tag: str = "enel-splat"
    ssh_user: str = "ubuntu"
    ssh_private_key: Optional[str] = None  # path; if None, ssh agent / default keys used


@dataclass
class InstantSplatConfig:
    # Official InstantSplat repository. It vendors MASt3R as a submodule.
    repo_url: str = "https://github.com/NVlabs/InstantSplat.git"
    repo_ref: str = "main"
    mast3r_checkpoint_url: str = (
        "https://download.europe.naverlabs.com/ComputerVision/MASt3R/"
        "MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric.pth"
    )
    train_iterations: int = 1000
    image_size: int = 512
    timestamps_per_feed: int = 2
    max_images: int = 12
    long_edge_px: int = 960
    temporal_neighbors: int = 1
    cross_view_drift: int = 0
    render_video: bool = False
    forward_api_keys: tuple[str, ...] = (
        "HF_TOKEN",
        "HUGGINGFACE_HUB_TOKEN",
        "WANDB_API_KEY",
    )


@dataclass
class PipelineConfig:
    workspace: Path
    job_id: str
    frames: FrameConfig = field(default_factory=FrameConfig)
    training: TrainingConfig = field(default_factory=TrainingConfig)
    lambda_: LambdaConfig = field(default_factory=LambdaConfig)
    remote_root: str = "/home/ubuntu/enel-splat"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["workspace"] = str(self.workspace)
        if d["lambda_"].get("api_key"):
            d["lambda_"]["api_key"] = "***"  # never serialise secrets
        return d


@dataclass
class InstantSplatPipelineConfig:
    workspace: Path
    job_id: str
    instantsplat: InstantSplatConfig = field(default_factory=InstantSplatConfig)
    lambda_: LambdaConfig = field(default_factory=lambda: LambdaConfig(tag="enel-instantsplat"))
    remote_root: str = "/home/ubuntu/enel-instantsplat"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["workspace"] = str(self.workspace)
        if d["lambda_"].get("api_key"):
            d["lambda_"]["api_key"] = "***"
        return d


def load_lambda_key() -> Optional[str]:
    """Resolve the Lambda Cloud API key from common locations, in order."""
    load_env_files()
    if key := os.environ.get("LAMBDA_API_KEY"):
        return key.strip()
    for candidate in (
        Path.home() / ".enel" / "lambda.key",
        Path.home() / ".lambda" / "api_key",
        Path.home() / ".config" / "lambda" / "api_key",
    ):
        if candidate.is_file():
            return candidate.read_text().strip()
    return None


def collect_api_env(names: tuple[str, ...]) -> dict[str, str]:
    """Return selected API-key env vars after loading local env files."""
    load_env_files()
    out: dict[str, str] = {}
    for name in names:
        value = os.environ.get(name)
        if value:
            out[name] = value.strip()
    return out
