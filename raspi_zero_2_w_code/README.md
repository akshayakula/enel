# Raspberry Pi Zero 2 W — RTSP camera publisher (v0)

Minimal RTSP/TCP publisher for an OV5647 CSI camera. Streams `1280x720@30` H.264
(~2 Mbps) to the laptop's MediaMTX at `cam1`/`cam2`/`cam3`/`cam4`.

**v0 scope:** live video publisher only. No control channel, no burst-stills
capture, no NeoPixel ring. Those ship in v1.

## Files

| File | What |
|---|---|
| `streamer.sh` | runs on the Pi: `rpicam-vid` → `ffmpeg -f rtsp -rtsp_transport tcp` |
| `streamer.service` | systemd unit that supervises `streamer.sh` |
| `streamer.conf.example` | config template (identity, server, stream profile) |
| `provision-sd.sh` | **run on Mac**: writes a filled `streamer.conf` to the SD's `bootfs` |
| `bootstrap-pi.sh` | **run on Mac**: SSH-installs ffmpeg + streamer onto a booted Pi |

## One-time: per-Pi flash workflow

### 1. Flash Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager

1. Open **Raspberry Pi Imager** → "Choose OS" → Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**.
2. "Choose Storage" → the SD card (currently named `NO NAME`).
3. Click the ⚙ gear ("OS Customization") and set:
   - **Hostname**: `pi-cam1` (use `pi-cam2` etc. for the other Pis)
   - **Enable SSH**: yes, use your public key (easier) or set a password
   - **Username/password**: e.g. `akshay` / something
   - **WiFi**: your SSID + password + country
4. Click **Save**, then **Write**. Wait for "successfully written" + verify.

When done, the SD will re-mount as `bootfs` under `/Volumes/bootfs`.

### 2. Drop `streamer.conf` onto the SD

From the repo root:

```bash
./raspi_zero_2_w_code/provision-sd.sh cam1 137.66.49.231 pi-cam1
```

Arguments: `<stream-id> <server-host> [pi-name]`. The server host is your
Mac's LAN IP for local development, or `137.66.49.231` for the deployed Fly app.

Eject the SD from the Mac, insert into the Pi, power on.

### 3. Bootstrap over SSH

Wait ~60 s after power-on for the Pi to join WiFi, then:

```bash
./raspi_zero_2_w_code/bootstrap-pi.sh pi-cam1.local akshay
```

This SSH-installs `ffmpeg`, drops in
`streamer.sh` and the systemd unit, and starts the service. Takes ~2 minutes
the first time (downloads ffmpeg).

Tail logs:

```bash
ssh akshay@pi-cam1.local 'journalctl -u streamer -f'
```

Open the dashboard and the `cam1` tile should go live:

```text
https://enel-stream.fly.dev/viewer
```

## Changing config later

Edit `/boot/firmware/streamer.conf` on the Pi (SSH or pull the SD card), then
`sudo systemctl restart streamer` on the Pi.

## Coming in v1

- Python rewrite of `streamer.sh` with the same camera handle used for both
  live stream **and** on-demand high-quality burst stills (splat capture).
- WebSocket control channel to the laptop.
- NeoPixel 16-ring compass + status UI on GPIO 18.
- `pi-gen` image build so a fresh SD is one `dd` away from running, no
  bootstrap step.
