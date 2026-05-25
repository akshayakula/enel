#!/usr/bin/env bash
# Bootstrap a Lambda Cloud Ubuntu/Lambda Stack box for MASt3R + InstantSplat.
set -euo pipefail

REMOTE_ROOT="${1:-$HOME/enel-instantsplat}"
REPO_URL="${INSTANTSPLAT_REPO_URL:-https://github.com/NVlabs/InstantSplat.git}"
REPO_REF="${INSTANTSPLAT_REPO_REF:-main}"
MAST3R_CHECKPOINT_URL="${MAST3R_CHECKPOINT_URL:-https://download.europe.naverlabs.com/ComputerVision/MASt3R/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric.pth}"

mkdir -p "$REMOTE_ROOT" "$REMOTE_ROOT/bin" "$REMOTE_ROOT/jobs" "$REMOTE_ROOT/repos"

STAMP="$REMOTE_ROOT/.bootstrap_instantsplat.ok"
SIG="$REPO_URL $REPO_REF $MAST3R_CHECKPOINT_URL"
if [[ -f "$STAMP" ]] && grep -qxF "$SIG" "$STAMP"; then
  echo "bootstrap_instantsplat: already complete"
  exit 0
fi

echo "bootstrap_instantsplat: apt installing system deps"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ffmpeg \
  git \
  wget \
  pigz \
  python3-venv \
  python3-pip \
  build-essential \
  cmake \
  ninja-build \
  libgl1 \
  libglib2.0-0 \
  >/tmp/instantsplat-apt.log 2>&1 || { tail -n 100 /tmp/instantsplat-apt.log; exit 1; }

REPO_DIR="$REMOTE_ROOT/repos/InstantSplat"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "bootstrap_instantsplat: cloning InstantSplat"
  git clone --recursive "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git fetch --tags origin >/tmp/instantsplat-git.log 2>&1 || { tail -n 80 /tmp/instantsplat-git.log; exit 1; }
git checkout "$REPO_REF" >>/tmp/instantsplat-git.log 2>&1 || { tail -n 80 /tmp/instantsplat-git.log; exit 1; }
git submodule update --init --recursive >>/tmp/instantsplat-git.log 2>&1 || { tail -n 80 /tmp/instantsplat-git.log; exit 1; }

VENV="$REMOTE_ROOT/instantsplat-venv"
if [[ -f "$VENV/pyvenv.cfg" ]] && grep -qi "include-system-site-packages = true" "$VENV/pyvenv.cfg"; then
  echo "bootstrap_instantsplat: replacing system-site-packages venv"
  rm -rf "$VENV"
fi
if [[ ! -d "$VENV" ]]; then
  echo "bootstrap_instantsplat: creating venv"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "bootstrap_instantsplat: installing python deps"
pip install --upgrade pip wheel setuptools ninja >/tmp/instantsplat-pip.log 2>&1

python - <<'PY' >>/tmp/instantsplat-pip.log 2>&1 || \
  pip install --index-url https://download.pytorch.org/whl/cu121 torch torchvision >>/tmp/instantsplat-pip.log 2>&1
import torch
assert torch.cuda.is_available(), "torch is installed but CUDA is not available"
print("torch", torch.__version__, "cuda", torch.version.cuda)
PY

python - <<'PY'
from pathlib import Path
tokens = Path("requirements.txt").read_text().split()
skip = {"torch", "torchvision", "numpy", "scipy", "cython", "pythran"}
Path("/tmp/instantsplat-requirements.filtered.txt").write_text(
    "\n".join(t for t in tokens if t not in skip) + "\n"
)
PY
pip install --force-reinstall \
  "numpy==1.26.4" \
  "scipy==1.11.4" \
  "Cython==0.29.37" \
  "pythran==0.16.1" \
  "pybind11>=2.11" \
  "scikit-learn==1.4.2" \
  >>/tmp/instantsplat-pip.log 2>&1 || {
  tail -n 120 /tmp/instantsplat-pip.log
  exit 1
}
pip install -r /tmp/instantsplat-requirements.filtered.txt >>/tmp/instantsplat-pip.log 2>&1 || {
  tail -n 120 /tmp/instantsplat-pip.log
  exit 1
}

PYBIND11_INCLUDE="$(python - <<'PY'
import pybind11
print(pybind11.get_include())
PY
)"
export CPATH="$PYBIND11_INCLUDE:${CPATH:-}"
export CPLUS_INCLUDE_PATH="$PYBIND11_INCLUDE:${CPLUS_INCLUDE_PATH:-}"

pip install --no-build-isolation submodules/simple-knn submodules/diff-gaussian-rasterization >>/tmp/instantsplat-pip.log 2>&1 || {
  tail -n 120 /tmp/instantsplat-pip.log
  exit 1
}
pip install --no-build-isolation submodules/fused-ssim >>/tmp/instantsplat-pip.log 2>&1 || \
  echo "bootstrap_instantsplat: fused-ssim install failed; training will use fallback SSIM"

CUROPE_DIR="$REPO_DIR/croco/models/curope"
if [[ -d "$CUROPE_DIR" ]]; then
  echo "bootstrap_instantsplat: compiling optional RoPE kernels"
  (cd "$CUROPE_DIR" && python setup.py build_ext --inplace) >>/tmp/instantsplat-pip.log 2>&1 || \
    echo "bootstrap_instantsplat: RoPE compile failed; continuing with python fallback"
fi

CKPT_DIR="$REPO_DIR/mast3r/checkpoints"
CKPT="$CKPT_DIR/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric.pth"
mkdir -p "$CKPT_DIR"
if [[ ! -s "$CKPT" ]]; then
  echo "bootstrap_instantsplat: downloading MASt3R checkpoint"
  wget -q "$MAST3R_CHECKPOINT_URL" -O "$CKPT.tmp"
  mv "$CKPT.tmp" "$CKPT"
fi

python - <<'PY' >/tmp/instantsplat-smoke.log 2>&1 || { tail -n 100 /tmp/instantsplat-smoke.log; exit 1; }
import torch
from mast3r.model import AsymmetricMASt3R
print("cuda", torch.cuda.is_available(), "gpus", torch.cuda.device_count())
print("mast3r", AsymmetricMASt3R.__name__)
PY

printf '%s\n' "$SIG" > "$STAMP"
echo "bootstrap_instantsplat: complete"
