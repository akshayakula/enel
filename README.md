# enel

Minimal multi-camera WebRTC wall for 4 Raspberry Pis that publish H.264 over RTSP/TCP to MediaMTX.

This version assumes:

1. The laptop runs MediaMTX as the actual media server.
2. Each Raspberry Pi publishes video-only to MediaMTX with an RTSP/TCP URL.
3. A separate iPhone Safari app can also publish video-only for smoke tests.
4. A small Node dashboard shows `cam1` through `cam4` simultaneously in a 2x2 grid.

This is a better fit than custom browser-to-browser signaling because MediaMTX handles RTSP ingest, WebRTC playback, and recording in one process, which gives us a cleaner path to MP4-based reconstruction work.

According to the current official MediaMTX docs, RTSP publishing uses URLs like `rtsp://host:8554/mystream`, browser playback is available through WebRTC/WHEP, and WebRTC connectivity on LAN setups often requires exposing TCP or UDP `8189`. Sources:

- [MediaMTX: RTSP clients / publish](https://mediamtx.org/docs/publish/rtsp-clients)
- [MediaMTX: Embed streams in a website](https://mediamtx.org/docs/features/embed-streams-in-a-website)
- [MediaMTX: WebRTC-specific features](https://mediamtx.org/docs/features/webrtc-specific-features)

## Architecture

- `scripts/start-mediamtx.sh` runs MediaMTX directly on the laptop for local development.
- `fly.toml`, `Dockerfile`, and `fly/mediamtx.yml` deploy Node + MediaMTX together on Fly.io.
- `mediamtx/mediamtx.yml` reserves the `cam1` to `cam4` paths.
- `mediamtx/mediamtx.yml` also records all streams to disk as fMP4 and exposes the playback server on port `9996`.
- `server.js` serves the dashboard plus two separate publisher apps on port `3000`.
- `web_rtc_app/public/viewer.html` embeds the four MediaMTX WebRTC viewers, starts server-side live capture, starts Lambda splat jobs, and lists previous mapping sessions.
- `web_rtc_app/public/iphone-safari.html` is the dedicated phone video-only publisher.
- `web_rtc_app/public/raspi.html` is the dedicated Raspberry Pi RTSP setup app.

## Quick start

Install the dashboard dependency:

```bash
npm install
```

Install MediaMTX once on the laptop:

```bash
brew install mediamtx
```

Start MediaMTX on the laptop:

```bash
./scripts/start-mediamtx.sh
```

Start the dashboard:

```bash
npm start
```

Open the dashboard on the laptop:

```text
https://LAPTOP_IP:3000/viewer
```

Open the Raspberry Pi app if you want the exact RTSP URLs:

```text
https://LAPTOP_IP:3000/raspi
```

Each Raspberry Pi should publish to one of these RTSP URLs:

```text
rtsp://LAPTOP_IP:8554/cam1
rtsp://LAPTOP_IP:8554/cam2
rtsp://LAPTOP_IP:8554/cam3
rtsp://LAPTOP_IP:8554/cam4
```

## Fly deployment

The production app is deployed at:

```text
https://enel-stream.fly.dev/viewer
```

Phones can join as temporary camera publishers at:

```text
https://enel-stream.fly.dev/phone
```

Phone publishers auto-pair only into `gnd-2` and `gnd-3` (`cam3`/`cam4`).
`air-1` (`cam1`) is reserved for the drone.

The Pi publisher should target the dedicated Fly IPv4 on RTSP/TCP:

```text
SERVER_HOST=137.66.49.231
RTSP_PORT=8554
STREAM_ID=cam1   # cam1..cam4 per unit
```

The Fly machine also exposes WebRTC ICE-over-TCP on `8189`. The browser still talks to MediaMTX through the dashboard's `/mediamtx` proxy, so the operator only needs the HTTPS dashboard URL.

When **begin mapping** is clicked, the server captures every live `cam1`-`cam4`
MediaMTX path over local RTSP/TCP, stores the clips in the session directory,
starts the Lambda workflow, and streams session progress/events back into the
mapping sessions list.

Mutable deployment state lives on the Fly volume under `/data`:

- `/data/recordings` for MediaMTX fMP4 recordings.
- `/data/sessions` for mapping-session manifests and uploaded clips.
- `/data/splat-workspaces` for Lambda job logs and `result/scene.splat`.
- `/data/scenes` for standalone viewer assets.

Required Fly secrets:

```bash
flyctl secrets set \
  LAMBDA_API_KEY=... \
  LAMBDA_SSH_KEY_NAME='...' \
  LAMBDA_SSH_PRIVATE_KEY_B64="$(base64 < ~/.ssh/<lambda-key> | tr -d '\n')" \
  MTX_WEBRTCADDITIONALHOSTS=137.66.49.231 \
  --app enel-stream
```

## Important setup note

The checked-in `mediamtx/mediamtx.yml` includes `127.0.0.1` and `localhost` in `webrtcAdditionalHosts`, but for the actual LAN deployment you should add the laptop's LAN IP there too, like `192.168.1.50`. That recommendation comes directly from the MediaMTX WebRTC connectivity guidance.

In this repo, we are intentionally not using Docker for MediaMTX. Host-native MediaMTX works better for LAN-facing WebRTC because the ICE ports are exposed directly by the laptop instead of being forwarded through a VM/container layer.

## Recording and export

Per the current official MediaMTX docs, recording is supported directly in the server by enabling `record: yes`, choosing a `recordPath`, and using either `fmp4` or `mpegts`. Playback can also be enabled on port `9996`, and recordings can be downloaded back out as `mp4` with the playback server. Sources:

- [MediaMTX: Record streams to disk](https://mediamtx.org/docs/usage/record)
- [MediaMTX: Playback recorded streams](https://mediamtx.org/docs/usage/playback)

This repo now records each camera stream automatically into `./recordings`.

Recommended export options:

1. Raw upload for Modal / Runpod:
   ```bash
   ./scripts/package-recordings.sh
   ```
   This creates a `.tar.gz` archive of the raw fMP4 recording tree plus a manifest file. This is the best choice if you want cloud workers to do their own stitching, alignment, or transcoding.

2. Consolidated MP4s for quick review or downstream jobs:
   ```bash
   ./scripts/export-latest-mp4s.sh
   ```
   This asks the MediaMTX playback server for the latest recorded span of each camera and writes `cam1.mp4` through `cam4.mp4` into `./exports/latest-mp4`.

The raw fMP4 recordings preserve more structure and are the better default handoff format for later processing. The MP4 export is more convenient for inspection and simple batch pipelines.

## COLMAP preprocessing

There is now a dedicated preprocessing folder at [video_to_gaussian_splat](/Users/puneetvelidi/enel/video_to_gaussian_splat/README.md) for turning recorded videos into a smaller COLMAP-ready image set.

The intended flow is:

1. Extract a low-FPS frame set from each camera video.
2. Score frames for sharpness / exposure / contrast.
3. Keep fewer, better, less-redundant frames for COLMAP.

This is meant to reduce the real bottleneck in the pipeline: COLMAP reconstruction time and stability.

## iPhone Safari app

For iPhone Safari publishing, generate the local certificate before starting the dashboard:

```bash
./scripts/generate-dev-cert.sh
```

Then open the phone publisher:

```text
https://LAPTOP_IP:3000/phone
```

This app publishes video only into `gnd-2` or `gnd-3` (`cam3`/`cam4`).
Browser phones publish through the dashboard's WebRTC publisher path; the
mapping workflow records from MediaMTX afterward, so phone and Pi streams are
handled the same way by Lambda. Use `?streamId=cam3` or `?streamId=cam4` only
when manually pinning a phone slot.

If the iPhone does not trust the local certificate yet, download it from:

```text
https://LAPTOP_IP:3000/dev-cert.pem
```

## Raspberry Pi app

Use:

```text
https://LAPTOP_IP:3000/raspi
```

to see the four assigned RTSP ingest endpoints for `cam1` through `cam4`. Configure each Pi to publish video only and omit audio entirely.

## Stopping services

Stop MediaMTX:

```bash
./scripts/stop-mediamtx.sh
```

Stop the dashboard with `Ctrl+C` in the terminal where `npm start` is running.
