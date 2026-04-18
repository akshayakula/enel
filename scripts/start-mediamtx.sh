#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/mediamtx/mediamtx.yml"
MEDIAMTX_BIN="/opt/homebrew/opt/mediamtx/bin/mediamtx"

if [ ! -x "${MEDIAMTX_BIN}" ]; then
  echo "MediaMTX is not installed at ${MEDIAMTX_BIN}"
  echo "Install it with: brew install mediamtx"
  exit 1
fi

exec "${MEDIAMTX_BIN}" "${CONFIG_FILE}"
