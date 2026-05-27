# enel streaming server for Fly.io: MediaMTX (RTSP in / WebRTC out) + Node dashboard.
FROM node:20-bookworm-slim

WORKDIR /app

# Install the latest MediaMTX release (linux amd64 — Fly builders/VMs are x86_64).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && VER=$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest \
        | grep -oE '"tag_name": *"[^"]+"' | head -1 | cut -d'"' -f4) \
 && echo "Installing MediaMTX ${VER}" \
 && curl -fL -o /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/releases/download/${VER}/mediamtx_${VER}_linux_amd64.tar.gz" \
 && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
 && rm /tmp/mediamtx.tar.gz \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

# Node dependencies (use lockfile when in sync, otherwise resolve).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application + server configs.
COPY server.js ./
COPY web_rtc_app ./web_rtc_app
COPY fly/mediamtx.yml ./mediamtx.yml
COPY fly/start.sh ./start.sh
RUN chmod +x ./start.sh

ENV HTTP_ONLY=1 \
    PORT=8080 \
    NODE_ENV=production

# 8080 dashboard (behind Fly TLS), 8554 RTSP ingest, 8189 WebRTC ICE-TCP.
EXPOSE 8080 8554 8189

CMD ["./start.sh"]
