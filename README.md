# enel

Minimal multi-camera WebRTC wall for 4 Raspberry Pis that publish with WHIP on the same LAN.

This version assumes:

1. The laptop runs MediaMTX as the actual media server.
2. Each Raspberry Pi publishes video-only to MediaMTX with a WHIP URL.
3. A separate iPhone Safari app can also publish video-only for smoke tests.
4. A small Node dashboard shows `cam1` through `cam4` simultaneously in a 2x2 grid.

This is a better fit than custom browser-to-browser signaling because WHIP ingest already matches how the Pis publish, and MediaMTX also gives us a cleaner path to recording and later MP4-based reconstruction work.

According to the current official MediaMTX docs, WHIP publishing uses URLs like `http://host:8889/mystream/whip`, browser playback is available at `http://host:8889/mystream`, and WebRTC connectivity on LAN setups often requires exposing port `8889` plus UDP or TCP `8189`. Sources:

- [MediaMTX: WebRTC clients / publish](https://mediamtx.org/docs/publish/webrtc-clients)
- [MediaMTX: Embed streams in a website](https://mediamtx.org/docs/features/embed-streams-in-a-website)
- [MediaMTX: WebRTC-specific features](https://mediamtx.org/docs/features/webrtc-specific-features)

## Architecture

- `scripts/start-mediamtx.sh` runs MediaMTX directly on the laptop.
- `mediamtx/mediamtx.yml` reserves the `cam1` to `cam4` paths.
- `mediamtx/mediamtx.yml` also records all streams to disk as fMP4 and exposes the playback server on port `9996`.
- `server.js` serves the dashboard plus two separate publisher apps on port `3000`.
- `web_rtc_app/public/viewer.html` embeds the four MediaMTX WebRTC viewers.
- `web_rtc_app/public/iphone-safari.html` is the dedicated iPhone Safari video-only publisher.
- `web_rtc_app/public/raspi.html` is the dedicated Raspberry Pi WHIP setup app.

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

Open the Raspberry Pi app if you want the exact WHIP URLs:

```text
https://LAPTOP_IP:3000/raspi
```

Each Raspberry Pi should publish to one of these WHIP URLs:

```text
http://LAPTOP_IP:8889/cam1/whip
http://LAPTOP_IP:8889/cam2/whip
http://LAPTOP_IP:8889/cam3/whip
http://LAPTOP_IP:8889/cam4/whip
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

## iPhone Safari app

For iPhone Safari publishing, generate the local certificate before starting the dashboard:

```bash
./scripts/generate-dev-cert.sh
```

Then open:

```text
https://LAPTOP_IP:3000/iphone-safari?streamId=cam1
```

This app publishes video only. It requests camera access without audio and posts directly to the local WHIP endpoint through the secure dashboard origin.

If the iPhone does not trust the local certificate yet, download it from:

```text
https://LAPTOP_IP:3000/dev-cert.pem
```

## Raspberry Pi app

Use:

```text
https://LAPTOP_IP:3000/raspi
```

to see the four assigned WHIP ingest endpoints for `cam1` through `cam4`. Configure each Pi to publish video only and omit audio entirely.

## Stopping services

Stop MediaMTX:

```bash
./scripts/stop-mediamtx.sh
```

Stop the dashboard with `Ctrl+C` in the terminal where `npm start` is running.
