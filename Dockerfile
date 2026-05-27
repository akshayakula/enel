FROM bluenviron/mediamtx:latest AS mediamtx

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    openssh-client \
    python3 \
    python3-venv \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY video_to_gaussian_splat/pyproject.toml ./video_to_gaussian_splat/
COPY video_to_gaussian_splat/splat ./video_to_gaussian_splat/splat
RUN python3 -m venv /app/video_to_gaussian_splat/.venv \
  && /app/video_to_gaussian_splat/.venv/bin/pip install --upgrade pip wheel setuptools \
  && /app/video_to_gaussian_splat/.venv/bin/pip install -e /app/video_to_gaussian_splat

COPY . .
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY fly/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
  PORT=8080 \
  ENEL_HTTPS=0 \
  DATA_DIR=/data \
  RECORDINGS_DIR=/data/recordings \
  EXPORTS_DIR=/data/exports/compiled \
  SCENES_DIR=/data/scenes \
  SESSIONS_DIR=/data/sessions \
  SPLAT_WORKSPACES_DIR=/data/splat-workspaces \
  SPLAT_PYTHON=/app/video_to_gaussian_splat/.venv/bin/python \
  MEDIAMTX_API_BASE=http://127.0.0.1:9997

EXPOSE 8080 8554 8189

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
