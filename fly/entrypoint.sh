#!/usr/bin/env bash
set -euo pipefail

mkdir -p \
  /data/recordings \
  /data/exports/compiled \
  /data/scenes \
  /data/sessions \
  /data/splat-workspaces \
  /data/secrets

if [[ -n "${LAMBDA_SSH_PRIVATE_KEY_B64:-}" ]]; then
  umask 077
  printf '%s' "$LAMBDA_SSH_PRIVATE_KEY_B64" | base64 -d > /data/secrets/lambda_ssh_key
  export SPLAT_SSH_PRIVATE_KEY=/data/secrets/lambda_ssh_key
fi

mediamtx /app/fly/mediamtx.yml &
MTX_PID=$!

node /app/server.js &
APP_PID=$!

shutdown() {
  kill "$APP_PID" "$MTX_PID" 2>/dev/null || true
  wait "$APP_PID" "$MTX_PID" 2>/dev/null || true
}
trap shutdown INT TERM

wait -n "$APP_PID" "$MTX_PID"
STATUS=$?
shutdown
exit "$STATUS"
