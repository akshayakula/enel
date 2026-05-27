#!/usr/bin/env bash
# One-shot installer: SSH into a freshly-booted Pi, install ffmpeg,
# drop in streamer.sh + streamer.service, enable and start the service.
#
# Usage:
#   ./bootstrap-pi.sh <pi-host> [ssh-user]
#
# Requires:
#   - Pi is booted, on WiFi, SSH is enabled
#   - Your SSH key is in the Pi's ~/.ssh/authorized_keys (Raspberry Pi Imager can set this up)
#   - /boot/firmware/streamer.conf already exists (run provision-sd.sh before first boot)

set -euo pipefail

PI_HOST="${1:-}"
SSH_USER="${2:-pi-sensor1}"

if [[ -z "$PI_HOST" ]]; then
  echo "usage: $0 <pi-host> [ssh-user]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pinned ffmpeg static build.
# BtbN builds are master/rolling; we use the "latest" arm64 GPL tarball here.
# If you need reproducibility, pin to a dated release from https://github.com/BtbN/FFmpeg-Builds/releases
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"

echo "==> copying streamer files to ${SSH_USER}@${PI_HOST}:/tmp/"
scp -o StrictHostKeyChecking=accept-new \
    "$SCRIPT_DIR/streamer.sh" \
    "$SCRIPT_DIR/streamer.service" \
    "$SCRIPT_DIR/streamer.conf.example" \
    "$SCRIPT_DIR/pi_control.py" \
    "$SCRIPT_DIR/pi-control.service" \
    "$SCRIPT_DIR/ring.py" \
    "$SCRIPT_DIR/wifi-j-autojoin.sh" \
    "$SCRIPT_DIR/wifi-j-autojoin.service" \
    "$SCRIPT_DIR/wifi-j-autojoin.timer" \
    "$SCRIPT_DIR/captive-accept.sh" \
    "$SCRIPT_DIR/captive-accept.service" \
    "$SCRIPT_DIR/captive-accept.timer" \
    "${SSH_USER}@${PI_HOST}:/tmp/"

echo "==> installing on Pi (this will prompt for sudo password)"
ssh -t "${SSH_USER}@${PI_HOST}" bash <<EOF
set -euo pipefail

echo "--- apt packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    rpicam-apps libcamera-apps curl xz-utils ca-certificates

if ! /usr/local/bin/ffmpeg -hide_banner -muxers 2>/dev/null | grep -q '\\brtsp\\b'; then
  echo "--- downloading static ffmpeg"
  # /tmp is tmpfs (~209MB on Pi Zero 2 W) — unpacked tarball is ~240MB. Use /var/tmp.
  tmp=\$(mktemp -d -p /var/tmp)
  curl -fL --progress-bar -o "\$tmp/ffmpeg.tar.xz" "$FFMPEG_URL"
  tar -xJf "\$tmp/ffmpeg.tar.xz" -C "\$tmp" --wildcards --no-anchored '*/bin/ffmpeg'
  ff_bin=\$(find "\$tmp" -type f -name ffmpeg | head -n1)
  sudo install -m 0755 "\$ff_bin" /usr/local/bin/ffmpeg
  rm -rf "\$tmp"
  echo "--- ffmpeg installed: \$(/usr/local/bin/ffmpeg -version | head -n1)"
else
  echo "--- ffmpeg already present"
fi

echo "--- installing streamer.sh"
sudo install -m 0755 /tmp/streamer.sh /usr/local/bin/streamer.sh

echo "--- installing streamer.service"
sudo install -m 0644 /tmp/streamer.service /etc/systemd/system/streamer.service

echo "--- installing Pi control helpers"
sudo install -m 0755 /tmp/pi_control.py /usr/local/bin/pi_control.py
sudo install -m 0644 /tmp/pi-control.service /etc/systemd/system/pi-control.service
sudo install -m 0755 /tmp/ring.py /usr/local/bin/ring.py

echo "--- installing Wi-Fi auto-join helpers"
sudo install -m 0755 /tmp/wifi-j-autojoin.sh /usr/local/bin/wifi-j-autojoin.sh
sudo install -m 0644 /tmp/wifi-j-autojoin.service /etc/systemd/system/wifi-j-autojoin.service
sudo install -m 0644 /tmp/wifi-j-autojoin.timer /etc/systemd/system/wifi-j-autojoin.timer
sudo install -m 0755 /tmp/captive-accept.sh /usr/local/bin/captive-accept.sh
sudo install -m 0644 /tmp/captive-accept.service /etc/systemd/system/captive-accept.service
sudo install -m 0644 /tmp/captive-accept.timer /etc/systemd/system/captive-accept.timer

if [[ ! -f /boot/firmware/streamer.conf ]]; then
  echo "--- WARNING: /boot/firmware/streamer.conf missing; copying example (you must edit it)"
  sudo install -m 0644 /tmp/streamer.conf.example /boot/firmware/streamer.conf
fi

echo "--- enabling + starting streamer.service"
sudo systemctl daemon-reload
sudo systemctl enable --now wifi-j-autojoin.timer
sudo systemctl enable --now captive-accept.timer
sudo systemctl enable pi-control.service
sudo systemctl restart pi-control.service
sudo systemctl enable streamer.service
sudo systemctl restart streamer.service
sleep 2
sudo systemctl status --no-pager streamer.service | head -20 || true

echo "--- done"
EOF

echo
echo "==> tail logs with:  ssh ${SSH_USER}@${PI_HOST} 'journalctl -u streamer -f'"
