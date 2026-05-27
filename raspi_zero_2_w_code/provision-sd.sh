#!/usr/bin/env bash
# Writes a filled /boot/firmware/streamer.conf to a freshly-flashed Pi OS SD card.
#
# Usage:
#   ./provision-sd.sh <stream-id> <server-host> [pi-name] [bootfs-path]
#
# Examples:
#   ./provision-sd.sh cam1 192.168.1.248 pi-cam-1
#   ./provision-sd.sh cam3 laptop.local  pi-livingroom /Volumes/bootfs
#
# After this, eject the SD card and boot the Pi. On first boot the streamer
# service isn't installed yet — SSH in and run bootstrap-pi.sh from the Mac.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <stream-id> <server-host> [pi-name] [bootfs-path]" >&2
  exit 1
fi

STREAM_ID="$1"
SERVER_HOST="$2"
PI_NAME="${3:-pi-$STREAM_ID}"
BOOTFS="${4:-/Volumes/bootfs}"

if [[ ! -d "$BOOTFS" ]]; then
  # Fall back to "NO NAME" (unflashed blank FAT card) or list likely candidates.
  if [[ -d "/Volumes/NO NAME" ]]; then
    echo "error: SD card at '/Volumes/NO NAME' looks blank — flash Raspberry Pi OS first." >&2
  else
    echo "error: bootfs not mounted at $BOOTFS" >&2
    echo "  currently mounted volumes:" >&2
    ls /Volumes >&2
  fi
  exit 1
fi

OUT="$BOOTFS/streamer.conf"
cat > "$OUT" <<EOF
# enel Pi streamer config (written by provision-sd.sh)
PI_NAME=$PI_NAME
STREAM_ID=$STREAM_ID

SERVER_HOST=$SERVER_HOST
COMMAND_SERVERS=https://enel-stream.fly.dev http://$SERVER_HOST:3605
WHIP_PORT=8889

WIDTH=1280
HEIGHT=720
FRAMERATE=30
BITRATE=2000000
EOF

echo "wrote $OUT"
echo
echo "next steps:"
echo "  1) eject the SD, boot the Pi"
echo "  2) find its IP/hostname (mDNS: $PI_NAME.local) and run:"
echo "     ./raspi_zero_2_w_code/bootstrap-pi.sh $PI_NAME.local"
