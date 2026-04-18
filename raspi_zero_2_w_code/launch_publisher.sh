#!/usr/bin/env bash

set -eu

if [ "$#" -lt 2 ]; then
  echo "Usage: ./launch_publisher.sh <laptop-ip> <stream-id>"
  echo "Example: ./launch_publisher.sh 192.168.1.50 cam1"
  exit 1
fi

LAPTOP_IP="$1"
STREAM_ID="$2"

echo "Publish this Pi with WHIP to:"
echo "  http://${LAPTOP_IP}:8889/${STREAM_ID}/whip"
echo
echo "Video only: disable or omit audio in the Pi publisher command."
echo "Replace this echo-only helper with your Pi WHIP publisher command."
