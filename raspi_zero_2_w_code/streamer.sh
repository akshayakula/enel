#!/usr/bin/env bash
# Pi streamer: publish H.264 to MediaMTX over RTSP/TCP.
# Source order of preference:
#   TEST_FILE (if set+exists) — loop the file, remux via -c:v copy.
#   TEST_MODE=1              — generate testsrc2 color bars.
#   default                  — real camera via rpicam-vid.
set -euo pipefail

CONF=/boot/firmware/streamer.conf
if [[ ! -f "$CONF" ]]; then
  echo "streamer: missing $CONF" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$CONF"

: "${STREAM_ID:?STREAM_ID not set in $CONF}"
: "${SERVER_HOST:?SERVER_HOST not set in $CONF}"
: "${RTSP_PORT:=8554}"
: "${WIDTH:=1280}"
: "${HEIGHT:=720}"
: "${FRAMERATE:=30}"
: "${BITRATE:=2000000}"
: "${TEST_MODE:=0}"
: "${TEST_FILE:=}"

RTSP_URL="rtsp://${SERVER_HOST}:${RTSP_PORT}/${STREAM_ID}"

if [[ -n "$TEST_FILE" && -f "$TEST_FILE" ]]; then
  echo "streamer: TEST_FILE mode — looping $TEST_FILE -> ${RTSP_URL}"
  exec ffmpeg -hide_banner -loglevel warning \
      -stream_loop -1 -re -i "$TEST_FILE" \
      -c:v copy -an \
      -f rtsp -rtsp_transport tcp "$RTSP_URL"
fi

if [[ "$TEST_MODE" == "1" ]]; then
  echo "streamer: TEST_MODE — publishing testsrc2 ${WIDTH}x${HEIGHT}@${FRAMERATE} -> ${RTSP_URL}"
  exec ffmpeg -hide_banner -loglevel warning \
      -re \
      -f lavfi -i "testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FRAMERATE}" \
      -vf "drawtext=text='${STREAM_ID} TEST':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.6:boxborderw=12:x=40:y=40" \
      -c:v libx264 -preset ultrafast -tune zerolatency \
      -profile:v baseline -level 4 -pix_fmt yuv420p \
      -b:v "$BITRATE" -maxrate "$BITRATE" -bufsize "$((BITRATE * 2))" \
      -g "$((FRAMERATE * 2))" -keyint_min "$FRAMERATE" \
      -f rtsp -rtsp_transport tcp "$RTSP_URL"
fi

echo "streamer: publishing ${WIDTH}x${HEIGHT}@${FRAMERATE} ${BITRATE}bps -> ${RTSP_URL}"
rpicam-vid \
    -t 0 --nopreview \
    --codec h264 --inline \
    --width "$WIDTH" --height "$HEIGHT" \
    --framerate "$FRAMERATE" \
    --bitrate "$BITRATE" \
    --profile baseline --level 4 \
    -o - \
  | exec ffmpeg -hide_banner -loglevel warning \
      -fflags +genpts \
      -f h264 -framerate "$FRAMERATE" -i - \
      -c:v copy \
      -f rtsp -rtsp_transport tcp "$RTSP_URL"
