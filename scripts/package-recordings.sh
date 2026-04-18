#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RECORDINGS_DIR="${ROOT_DIR}/recordings"
OUT_DIR="${1:-${ROOT_DIR}/exports/packages}"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
ARCHIVE_PATH="${OUT_DIR}/recordings_${TIMESTAMP}.tar.gz"
MANIFEST_PATH="${OUT_DIR}/recordings_${TIMESTAMP}_manifest.txt"

mkdir -p "${OUT_DIR}"

if [ ! -d "${RECORDINGS_DIR}" ]; then
  echo "No recordings directory found at ${RECORDINGS_DIR}"
  exit 1
fi

find "${RECORDINGS_DIR}" -type f | sort > "${MANIFEST_PATH}"
tar -czf "${ARCHIVE_PATH}" -C "${ROOT_DIR}" recordings

echo "Created archive:"
echo "  ${ARCHIVE_PATH}"
echo "Created manifest:"
echo "  ${MANIFEST_PATH}"
