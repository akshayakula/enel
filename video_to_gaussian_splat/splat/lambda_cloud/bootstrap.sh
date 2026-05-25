#!/usr/bin/env bash
# One-shot bootstrap for a Lambda Cloud "Lambda Stack" Ubuntu image.
# Idempotent: safe to re-run when reusing a warm instance.
set -euo pipefail

REMOTE_ROOT="${1:-$HOME/enel-splat}"
mkdir -p "$REMOTE_ROOT" "$REMOTE_ROOT/bin" "$REMOTE_ROOT/jobs"

STAMP="$REMOTE_ROOT/.bootstrap.ok"
if [[ -f "$STAMP" ]]; then
  echo "bootstrap: already complete ($(cat "$STAMP"))"
  exit 0
fi

echo "bootstrap: apt installing system deps"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  colmap \
  ffmpeg \
  python3-venv \
  python3-pip \
  build-essential \
  git \
  pigz \
  >/tmp/apt.log 2>&1 || { tail -n 80 /tmp/apt.log; exit 1; }

VENV="$REMOTE_ROOT/venv"
if [[ ! -d "$VENV" ]]; then
  echo "bootstrap: creating venv"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "bootstrap: installing python deps (this can take a couple of minutes the first time)"
pip install --upgrade pip wheel >/tmp/pip.log 2>&1
# Lambda Stack ships PyTorch with CUDA already; reuse it. We only add what's missing.
pip install --quiet \
  "numpy<2.1" \
  "pillow>=10" \
  "tqdm>=4.66" \
  "plyfile>=1.0" \
  "opencv-python-headless>=4.9" \
  "pycolmap>=3.10" \
  >>/tmp/pip.log 2>&1
# gsplat builds CUDA kernels on first import — pre-build now so the training step is fast.
pip install --quiet "gsplat>=1.4.0" >>/tmp/pip.log 2>&1 || {
  echo "bootstrap: gsplat wheel install failed; falling back to source build"
  pip install --quiet --no-binary=:all: "gsplat>=1.4.0" >>/tmp/pip.log 2>&1
}

# Smoke-import to trigger CUDA extension compilation now (cached afterwards).
python3 -c "import torch, gsplat; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('gsplat', gsplat.__version__)" \
  >/tmp/smoke.log 2>&1 || { tail -n 80 /tmp/smoke.log; exit 1; }

date -u +%FT%TZ > "$STAMP"
echo "bootstrap: complete"
