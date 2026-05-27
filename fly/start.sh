#!/bin/bash
# Supervisor: run MediaMTX + the Node dashboard in one machine. If either exits,
# tear down so Fly restarts the whole machine (keeps the pair in sync).
set -euo pipefail

echo "[start] launching MediaMTX"
mediamtx /app/mediamtx.yml &

echo "[start] launching Node dashboard (HTTP, behind Fly TLS)"
node /app/server.js &

# Exit as soon as any child exits.
wait -n
echo "[start] a child process exited — shutting down machine"
kill 0 2>/dev/null || true
exit 1
