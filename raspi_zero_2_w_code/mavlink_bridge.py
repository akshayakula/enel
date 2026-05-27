#!/usr/bin/env python3
"""enel mavlink-bridge: single-cam (cam1) drone link.

Holds one UART connection to the flight controller and exposes a WebSocket on
port 8090. The laptop's Express server proxies /api/pi/cam1/mavlink → this port.

Wire protocol (JSON per frame):

  browser → bridge:
    {"type":"yaw", "pwm": 1000..2000}     # CH4 override, all others released
    {"type":"arm", "on": true | false}    # MAV_CMD_COMPONENT_ARM_DISARM

  bridge → browser (push, ~5 Hz):
    {"type":"tele",
     "hb": {"fresh": true, "mode": "STABILIZE"},
     "armed": false,
     "gps":  {"fix": 3, "lat": 37.77, "lon": -122.41, "alt_m": 12.3, "sats": 14},
     "att":  {"roll_deg": 1.2, "pitch_deg": -0.4, "yaw_deg": 178.0},
     "batt": {"v": 12.4, "a": 3.1, "pct": 74}}

Safety:
- Yaw deadman: if no {type:"yaw"} arrives within 250 ms the next override frame
  sends CH4=0 (release). All other channels are ALWAYS 0 (released) — physical
  TX still owns roll/pitch/throttle/CH5-8.
- Arm requires a fresh heartbeat. The UI gates on this too, but we double-check.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import threading
import time
from typing import Any

from pymavlink import mavutil
import websockets

SERIAL_DEV    = os.environ.get("MAV_DEV",  "/dev/ttyAMA0")
SERIAL_BAUD   = int(os.environ.get("MAV_BAUD", "921600"))
WS_PORT       = int(os.environ.get("MAV_WS_PORT", "8090"))
# Fly uplink: the Pi is behind NAT, so it CONNECTS OUT to the server and pushes
# telemetry / receives arm+yaw commands. Set MAV_UPLINK_URL="" to disable.
UPLINK_URL    = os.environ.get("MAV_UPLINK_URL",
                               "wss://enel-stream.fly.dev/api/pi/cam1/mavlink/uplink")

RC_SEND_HZ    = 20        # RC_CHANNELS_OVERRIDE send rate
TELE_HZ       = 5         # telemetry push rate to all WS clients
YAW_DEADMAN_S = 0.25      # if no yaw update in this long → release CH4
HB_FRESH_S    = 2.0       # heartbeat considered fresh within this window

RELEASED = 0              # pymavlink RC override: 0 = release channel

# ---------- shared state (locked on _lock) -----------------------------------
_lock = threading.Lock()
_state: dict[str, Any] = {
    "yaw_pwm":   1500,     # last commanded yaw PWM
    "yaw_ts":    0.0,      # monotonic() of last yaw frame
    "hb_ts":     0.0,      # monotonic() of last HEARTBEAT
    "mode":      "?",
    "armed":     False,
    "gps":       None,
    "att":       None,
    "batt":      None,
    "target_sys": 1,
    "target_cmp": 1,
}


def _snap() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


# ---------- MAVLink worker (runs in its own thread) --------------------------
def mavlink_thread(stop: threading.Event, mav: mavutil.mavfile) -> None:
    mav.wait_heartbeat(blocking=True, timeout=10)
    _set(target_sys=mav.target_system, target_cmp=mav.target_component,
         hb_ts=time.monotonic())

    # Ask the FC to stream more aggressively (4 Hz for common message groups).
    for stream_id in (
        mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS,  # GPS, SYS_STATUS
        mavutil.mavlink.MAV_DATA_STREAM_POSITION,         # GLOBAL_POSITION_INT
        mavutil.mavlink.MAV_DATA_STREAM_EXTRA1,           # ATTITUDE
    ):
        mav.mav.request_data_stream_send(
            mav.target_system, mav.target_component, stream_id, 4, 1,
        )

    next_rc = time.monotonic()
    rc_period = 1.0 / RC_SEND_HZ

    while not stop.is_set():
        # 1. Drain all MAVLink messages that have arrived.
        while True:
            msg = mav.recv_match(blocking=False)
            if not msg:
                break
            t = msg.get_type()
            if t == "HEARTBEAT":
                base = getattr(msg, "base_mode", 0)
                armed = bool(base & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                mode_name = mavutil.mode_string_v10(msg) or "?"
                _set(hb_ts=time.monotonic(), armed=armed, mode=mode_name)
            elif t == "GLOBAL_POSITION_INT":
                _set(gps={
                    **(_snap().get("gps") or {}),
                    "lat":  msg.lat / 1e7,
                    "lon":  msg.lon / 1e7,
                    "alt_m": msg.alt / 1000.0,
                })
            elif t == "GPS_RAW_INT":
                gps = dict(_snap().get("gps") or {})
                gps["fix"]  = msg.fix_type
                gps["sats"] = msg.satellites_visible
                _set(gps=gps)
            elif t == "ATTITUDE":
                _set(att={
                    "roll_deg":  msg.roll  * 57.29578,
                    "pitch_deg": msg.pitch * 57.29578,
                    "yaw_deg":  (msg.yaw   * 57.29578) % 360.0,
                })
            elif t == "SYS_STATUS":
                _set(batt={
                    "v":   msg.voltage_battery / 1000.0,
                    "a":   msg.current_battery / 100.0 if msg.current_battery >= 0 else None,
                    "pct": msg.battery_remaining if msg.battery_remaining >= 0 else None,
                })

        # 2. RC override at 20 Hz. CH4 carries our yaw; all others released.
        now = time.monotonic()
        if now >= next_rc:
            snap = _snap()
            fresh = (now - snap["yaw_ts"]) < YAW_DEADMAN_S
            yaw   = int(snap["yaw_pwm"]) if fresh else RELEASED
            try:
                mav.mav.rc_channels_override_send(
                    snap["target_sys"], snap["target_cmp"],
                    RELEASED, RELEASED, RELEASED, yaw,
                    RELEASED, RELEASED, RELEASED, RELEASED,
                )
            except Exception:
                pass
            next_rc = now + rc_period

        time.sleep(0.005)


def send_arm(mav: mavutil.mavfile, on: bool) -> None:
    mav.mav.command_long_send(
        mav.target_system, mav.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,                              # confirmation
        1 if on else 0,                 # param1 (arm=1, disarm=0)
        0, 0, 0, 0, 0, 0,
    )


def build_tele() -> dict:
    s = _snap()
    hb_fresh = (time.monotonic() - s["hb_ts"]) < HB_FRESH_S
    return {
        "type":  "tele",
        "hb":    {"fresh": hb_fresh, "mode": s["mode"]},
        "armed": bool(s["armed"]),
        "gps":   s["gps"],
        "att":   s["att"],
        "batt":  s["batt"],
    }


def apply_command(mav: mavutil.mavfile, msg: dict):
    """Apply a yaw/arm command from any client; return an optional reply dict."""
    t = msg.get("type")
    if t == "yaw":
        try:
            pwm = int(msg.get("pwm", 1500))
        except (TypeError, ValueError):
            return None
        _set(yaw_pwm=max(1000, min(2000, pwm)), yaw_ts=time.monotonic())
        return None
    if t == "arm":
        on = bool(msg.get("on"))
        # Require fresh heartbeat to allow ARM. DISARM always allowed.
        if on and (time.monotonic() - _snap()["hb_ts"] > HB_FRESH_S):
            return {"type": "err", "msg": "no heartbeat; arm refused"}
        try:
            send_arm(mav, on)
            return {"type": "ack", "action": "arm" if on else "disarm"}
        except Exception as e:
            return {"type": "err", "msg": str(e)}
    return None


# ---------- WebSocket server -------------------------------------------------
async def tele_pusher(ws) -> None:
    period = 1.0 / TELE_HZ
    try:
        while True:
            await ws.send(json.dumps(build_tele()))
            await asyncio.sleep(period)
    except websockets.exceptions.ConnectionClosed:
        return


def make_handler(mav: mavutil.mavfile):
    async def handler(ws):
        push = asyncio.create_task(tele_pusher(ws))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                resp = apply_command(mav, msg)
                if resp:
                    try:
                        await ws.send(json.dumps(resp))
                    except Exception:
                        pass
        finally:
            push.cancel()
    return handler


async def serve(mav: mavutil.mavfile) -> None:
    async with websockets.serve(make_handler(mav), "0.0.0.0", WS_PORT,
                                ping_interval=10, ping_timeout=10):
        await asyncio.Future()  # run forever


async def uplink(mav: mavutil.mavfile) -> None:
    """Outbound link to the Fly dashboard: push telemetry, receive arm/yaw.
    The Pi is behind NAT, so it dials OUT and keeps reconnecting."""
    if not UPLINK_URL:
        return
    while True:
        try:
            async with websockets.connect(UPLINK_URL, ping_interval=10,
                                          ping_timeout=10, open_timeout=10) as ws:
                print(f"[mavlink_bridge] uplink connected -> {UPLINK_URL}", flush=True)

                async def pusher():
                    period = 1.0 / TELE_HZ
                    while True:
                        await ws.send(json.dumps(build_tele()))
                        await asyncio.sleep(period)

                push = asyncio.create_task(pusher())
                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        resp = apply_command(mav, msg)
                        if resp:
                            try:
                                await ws.send(json.dumps(resp))
                            except Exception:
                                pass
                finally:
                    push.cancel()
        except Exception as e:
            print(f"[mavlink_bridge] uplink down ({e}); retry in 5s", flush=True)
        await asyncio.sleep(5)


async def run_all(mav: mavutil.mavfile) -> None:
    await asyncio.gather(serve(mav), uplink(mav))


def main() -> None:
    print(f"[mavlink_bridge] opening {SERIAL_DEV} @ {SERIAL_BAUD}", flush=True)
    mav = mavutil.mavlink_connection(SERIAL_DEV, baud=SERIAL_BAUD, autoreconnect=True)

    stop = threading.Event()
    t = threading.Thread(target=mavlink_thread, args=(stop, mav), daemon=True)
    t.start()

    def _exit(_sig, _frame):
        stop.set()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _exit)
    signal.signal(signal.SIGINT,  _exit)

    try:
        asyncio.run(run_all(mav))
    finally:
        stop.set()


if __name__ == "__main__":
    main()
