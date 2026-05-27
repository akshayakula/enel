# AGENTS.md — enel project knowledge

Hard-won operational knowledge for agents working on this repo. Keep this current.

## System overview
- **Dashboard**: Node `server.js` (Express) + MediaMTX, serves the viewer UI.
- **Fly.io deploy**: app `enel-stream`, dedicated IPv4 `137.66.49.231`, region `iad`.
  Dashboard on `:443` (Fly terminates TLS → plain HTTP `:8080`, `HTTP_ONLY=1`),
  RTSP ingest `:8554`, WebRTC ICE-TCP `:8189` (raw TCP passthrough). Deploy: `fly deploy`.
- **Pis** (Raspberry Pi Zero 2 W, RPi OS / Debian 13 trixie, NetworkManager):
  - **Ground unit** `pi-cam-1.local` — user `pi-sensor1`, pass `123456`. Runs the camera streamer.
  - **Air unit** `pi-air-1.local` — user `pi-air1`, pass `123456`. Companion computer:
    MAVLink bridge to the flight controller (no camera/ring/battery module yet).
  - SSH non-interactively: `sshpass -p 123456 ssh -o NumberOfPasswordPrompts=1 <user>@<host>`.
    sshpass occasionally glitches on rapid reconnects — just retry after a short pause.
  - **WiFi**: both auto-connect to home/bench WiFi AND the iPhone hotspot
    SSID `Akshay's Iphone` / psk `Sidsacapper` (NetworkManager profile, autoconnect-priority -10
    so home wins when both present). Deployed on pi-air-1; **pending on pi-cam-1**.
  - Security is explicitly NOT a concern for this project (plaintext creds OK).

## Streaming
- Stream key is **`cam1`** (a `gnd1` rename was tried and fully reverted — Pi publishes RTSP `cam1`).
- Pi camera streamer (`raspi_zero_2_w_code/streamer.sh`, conf at `/boot/firmware/streamer.conf`)
  dual-publishes via ffmpeg `tee` to `FLY_HOST=137.66.49.231` AND `LAN_HOST=192.168.1.248`.
  Conf vars: `STREAM_ID`, `FLY_HOST`, `LAN_HOST`, `RTSP_PORT=8554`, `PUBLISH_MODE` (both|lan|server).
  `SERVER_HOST` in the script is a no-op — only FLY_HOST/LAN_HOST count.
- **Common outage**: empty `streamer.conf` (0 bytes) → service crash-loops "STREAM_ID not set".
  Fix by rewriting the conf, then `systemctl reset-failed streamer && systemctl restart streamer`.
- Repo's `streamer.sh`/`streamer.conf.example` were stale vs the installed dual-publish version.

## Flight controller (the air-unit drone)
- **ArduCopter 4.6.3, quad-X**, **BlueJay (BLHeli_S) ESCs**, DShot300. Connect via `pymavlink`.
  Direct USB on a laptop: `/dev/cu.usbmodem*` @ 115200. On Python 3.14 wrap `recv_match` in
  try/except TypeError (parse bug). After `PREFLIGHT_REBOOT_SHUTDOWN`, USB re-enumerates.
- **Motor → output-channel map** (test# = ArduPilot clockwise test order, NOT output number):
  Motor1=ch1(test1,CCW), Motor2=ch4(test4,CCW), Motor3=ch3(test2,CW), Motor4=ch2(test3,CW).
- **`SERVO_BLH_RVMASK` (DShot software reverse) is INERT on these BlueJay ESCs.** To reverse a
  motor, do a physical 2-of-3 wire swap (each swap toggles direction — swap once, test, stop).
- **No GPS / no compass / onboard baro only**: `EK3_SRC1_POSXY=0`, `VELXY=0`, `VELZ=0`
  (keep `POSZ=1` baro). Gives STABILIZE / ACRO / ALT_HOLD. Without this, arming fails
  "AHRS: EK3 sources require GPS".
- **3S battery is fine** — all battery-failsafe thresholds are 0 (disabled), so 3S won't trip
  low-voltage failsafe. Less thrust than 4S. The FC BEC powers the Pi cleanly under motor load
  (`vcgencmd get_throttled` = 0x0 even at ~3A).
- **Bench testing** (PROPS OFF): `ARMING_CHECK=0` + `DISARM_DELAY=0` (RESTORE to 1 and 10 before
  flight). Arm via `MAV_CMD_COMPONENT_ARM_DISARM`. Drive sticks via `RC_CHANNELS_OVERRIDE`
  (ch1 roll, ch2 pitch, ch3 throttle, ch4 yaw, ch5 arm-switch=2000).
  - **Throttle-gated mixing**: below ~30% throttle motors sit at MOT_SPIN_ARM and IGNORE
    attitude input — must be >~30% to see roll/pitch/yaw differential.
  - **RC override MUST be sent at a steady ~20Hz from a dedicated thread.** If the ELRS TX is
    OFF the FC is in RADIO FAILSAFE and pins the motors; irregular override (gated behind
    blocking reads) won't clear it. 20Hz steady emits "Radio Failsafe Cleared" and the FC then
    receives the override (verify via RC_CHANNELS chan3) and drives all 4 motors.
  - **Clean disarm**: override ch5 LOW (1000, estop for RC5_OPTION=153) + force-disarm
    (`COMPONENT_ARM_DISARM` p1=0 p2=21196), release overrides, verify. Most reliable disarm =
    via the bridge WS `{"type":"arm","on":false}`.
- **Accel calibration** (`drone_tools/imu_cal.py`): send GCS heartbeats (source_system 255);
  REBOOT first for a clean state; start accel cal DIRECTLY after reboot (NOT after gyro cal);
  FC prompts "Place level" ONCE then GCS drives positions 1..6; send
  `MAV_CMD_ACCELCAL_VEHICLE_POS` (42429) ONCE per position (resend = FAILED). **Not yet completed.**
- ELRS RC receiver (CRSF) is on **SERIAL1** (`PROTOCOL=23`). Arm switch on **ch5**
  (`RC5_OPTION=153` = Arm/Emergency-Stop). `ARMING_RUDDER=0`.

## Air-unit companion link (Pi ↔ FC)
- **Wiring**: FC "RC"/UART5 port = **SERIAL6** in ArduPilot. 4-wire: FC 5V→Pi pin2, GND→pin6,
  FC Tx5→Pi pin10 (GPIO15/RX), FC Rx5→Pi pin8 (GPIO14/TX). Crossed; 3.3V logic; Pi powered from
  the FC 5V. FC params: `SERIAL6_PROTOCOL=2` (MAVLink2), `SERIAL6_BAUD=921` (921600).
- **Pi serial**: `/boot/firmware/config.txt` has `enable_uart=1` + `dtoverlay=disable-bt`
  (puts PL011 `/dev/ttyAMA0` on GPIO14/15 @ 921600); console freed; `pi-air1` in `dialout`.
- **pymavlink install on trixie/Zero 2 W**: no apt `python3-pymavlink`; Pi pip downloads of the
  6MB sdist fail on flaky wifi → `curl` the tarball on a good network and `scp` it, then
  `apt install cython3 python3-dev gcc python3-lxml python3-serial` and
  `pip3 install --break-system-packages --no-build-isolation --no-deps pymavlink-*.tar.gz`
  (no-build-isolation uses the apt lxml; `python3-future` does NOT exist on trixie — pip it).
  Install **system-wide as root** OR run the service as the user (we run `mavlink-bridge.service`
  as `User=pi-air1` since deps are in its user site).
- **`mavlink_bridge.py`**: opens `/dev/ttyAMA0 @ 921600`, holds the FC link, sends RC override at
  20Hz (CH4 yaw; others released so the ELRS pilot owns throttle/roll/pitch), serves a local WS
  on `:8090`, and (new) dials OUT to Fly. Commands: `{"type":"arm","on":bool}`,
  `{"type":"yaw","pwm":1000-2000}`. Telemetry frames: `{"type":"tele",...}`.
- VERIFIED: Pi powered by FC, MAVLink link live, **arm/throttle/yaw all controllable from the Pi**.

## MAVLink-over-Fly (broadcasting drone data to the cloud) — IN PROGRESS, BLOCKED
- The Pi is behind NAT, so it CONNECTS OUT: `server.js` has a relay — Pi dials
  `/api/pi/<cam>/mavlink/uplink` (pushes telemetry, receives commands); browser connects to
  `/api/pi/<cam>/mavlink`; the server relays between them. `mavlink_bridge.py` has an outbound
  `uplink()` coroutine (default `MAV_UPLINK_URL=wss://enel-stream.fly.dev/api/pi/cam1/mavlink/uplink`).
- **BLOCKER**: **Fly's HTTP proxy mangles WebSocket permessage-deflate** → frames get RSV1 set
  and clients reject with `1002 "reserved bits must be 0"`, with deflate either ON or OFF.
  The relay CODE is correct (proven: it streams cleanly on a local-only WS test). The Pi→Fly
  UPLINK stays connected (deflate off), but the server→client DOWNLINK fails over Fly.
- **FIX (TODO)**: move MAVLink-over-Fly from WebSocket to **HTTP polling** — the same mechanism
  the camera/command system already uses successfully through Fly (`/api/battery`, `/api/control`,
  `/api/command`). i.e. Pi POSTs telemetry + polls commands; browser GETs telemetry + POSTs
  commands. WebSocket works fine on LAN (no Fly proxy) for local testing.

## Helper scripts (`drone_tools/`)
- `imu_cal.py` — interactive accel calibration (drive via `/tmp/imu_cal_cmd`: `echo go|abort`).
- `arm_yaw_test.py` — standalone arm+throttle+yaw test (auto-restores ARMING_CHECK/DISARM_DELAY).
  NOTE: should be updated to use a threaded 20Hz override sender (single-loop version is
  unreliable when the TX is off / radio failsafe).
- Param backups: `drone_params/arducopter_4.6.3_params_*.param`.

## Git
- `main` is the consolidated branch; the old `codex/*` and `fix/stream-key-cam1` branches are all
  merged in. Favor main's newer work and the **Fly path over any LAN logic** when resolving conflicts.
