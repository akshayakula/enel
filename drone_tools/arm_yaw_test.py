#!/usr/bin/env python3
"""
Standalone arm + throttle + yaw bench test over MAVLink — the same procedure we
ran from the Mac, but runnable ON the air-unit Pi (companion computer) over its
UART link to the flight controller. PROPS OFF ONLY.

Drives everything itself via RC_CHANNELS_OVERRIDE (no transmitter needed):
  arms (ARMING_CHECK temporarily 0), spools throttle, yaw right/left while
  reading the four motor outputs, then disarms cleanly and restores params.

Default device:
  Pi (air unit):  /dev/ttyAMA0 @ 921600   (FC companion UART)
  Mac (bench):    auto /dev/cu.usbmodem* @ 115200
Override with:  --dev /dev/ttyAMA0 --baud 921600

Key facts baked in (see memory: drone-bench-methodology):
  * throttle-gated mixing — yaw only differentiates the motors above ~30% throttle
  * clean disarm = drive arm-switch ch5 LOW (estop) + force-disarm (21196)
  * restores ARMING_CHECK and DISARM_DELAY to flight-safe values on exit
"""
import sys, time, glob, argparse
from pymavlink import mavutil

NOCH = 65535


def srecv(m, **kw):
    try:
        return m.recv_match(**kw)
    except TypeError:
        return None


def pick_dev(arg):
    if arg:
        return arg
    usb = sorted(glob.glob("/dev/cu.usbmodem*"))
    if usb:
        return usb[0]
    return "/dev/ttyAMA0"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", default=None)
    ap.add_argument("--baud", type=int, default=None)
    ap.add_argument("--throttle-pct", type=int, default=35)
    ap.add_argument("--no-restore", action="store_true",
                    help="leave ARMING_CHECK/DISARM_DELAY as set for the test")
    args = ap.parse_args()

    dev = pick_dev(args.dev)
    baud = args.baud or (921600 if "ttyAMA" in dev or "serial" in dev else 115200)
    print(f"connecting {dev} @ {baud}")
    m = mavutil.mavlink_connection(dev, baud=baud)
    t0 = time.time()
    while time.time() - t0 < 12:
        if srecv(m, type='HEARTBEAT', blocking=True, timeout=2):
            break
    else:
        print("no heartbeat — check wiring/baud"); sys.exit(1)
    tgt = (m.target_system, m.target_component)
    print(f"connected sys={tgt[0]}")

    def getp(name):
        m.mav.param_request_read_send(tgt[0], tgt[1], name, -1)
        p = srecv(m, type='PARAM_VALUE', blocking=True, timeout=3)
        return int(p.param_value) if p else None

    def setp(name, val):
        m.mav.param_set_send(tgt[0], tgt[1], name, float(val),
                             mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        time.sleep(0.4)

    orig_check = getp(b'ARMING_CHECK')
    orig_delay = getp(b'DISARM_DELAY')
    print(f"orig ARMING_CHECK={orig_check} DISARM_DELAY={orig_delay}")
    setp(b'ARMING_CHECK', 0)
    setp(b'DISARM_DELAY', 0)

    def ovr(thr=988, yaw=1500, arm=2000):
        m.mav.rc_channels_override_send(tgt[0], tgt[1],
            1500, 1500, thr, yaw, arm, NOCH, NOCH, NOCH)

    for _ in range(8):
        ovr(); time.sleep(0.1)
    m.mav.request_data_stream_send(tgt[0], tgt[1],
        mavutil.mavlink.MAV_DATA_STREAM_ALL, 15, 1)
    # STABILIZE
    m.mav.command_long_send(tgt[0], tgt[1], mavutil.mavlink.MAV_CMD_DO_SET_MODE, 0,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, 0, 0, 0, 0, 0, 0)
    time.sleep(0.4)

    print(">>> ARMING")
    m.mav.command_long_send(tgt[0], tgt[1],
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 1, 0, 0, 0, 0, 0, 0)
    t0 = time.time(); armed = False
    while time.time() - t0 < 5:
        ovr()
        hb = srecv(m, type='HEARTBEAT', blocking=True, timeout=0.3)
        if hb and hb.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED:
            armed = True; break
    print("armed =", armed)

    def phase(label, thr, yaw, secs=3):
        print(f"\n=== {label} (thr={thr} yaw={yaw}) ===")
        rows = []; t0 = time.time()
        while time.time() - t0 < secs:
            ovr(thr=thr, yaw=yaw)
            so = srecv(m, type='SERVO_OUTPUT_RAW', blocking=True, timeout=0.2)
            if so:
                rows.append([so.servo1_raw, so.servo2_raw, so.servo3_raw, so.servo4_raw])
            time.sleep(0.12)
        if rows:
            n = len(rows)
            a = [round(sum(r[i] for r in rows)/n) for i in range(4)]
            print(f"  avg ch1={a[0]} ch2={a[1]} ch3={a[2]} ch4={a[3]}")

    if armed:
        thr = 1000 + int(args.throttle_pct * 10)  # pct -> 1000..2000
        print(f">>> spooling to {args.throttle_pct}% ({thr})")
        for t in range(990, thr + 1, 30):
            for _ in range(2): ovr(thr=t); time.sleep(0.1)
        phase("BASELINE yaw center", thr, 1500)
        phase("YAW RIGHT", thr, 1750)
        phase("YAW LEFT", thr, 1250)
        # spool down
        for t in range(thr, 985, -40):
            ovr(thr=t); time.sleep(0.08)

    print("\n>>> CLEAN DISARM")
    for i in range(12):
        m.mav.rc_channels_override_send(tgt[0], tgt[1], 1500, 1500, 988, 1500, 1000, NOCH, NOCH, NOCH)
        if i in (3, 7):
            m.mav.command_long_send(tgt[0], tgt[1],
                mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 0, 21196, 0, 0, 0, 0, 0)
        time.sleep(0.2)
    for _ in range(8):
        m.mav.rc_channels_override_send(tgt[0], tgt[1], 0, 0, 0, 0, 0, 0, 0, 0); time.sleep(0.1)
    t0 = time.time(); fin = None
    while time.time() - t0 < 4:
        hb = srecv(m, type='HEARTBEAT', blocking=True, timeout=2)
        if hb is not None:
            fin = bool(hb.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
    print("armed =", fin)

    if not args.no_restore:
        setp(b'ARMING_CHECK', orig_check if orig_check is not None else 1)
        setp(b'DISARM_DELAY', orig_delay if orig_delay is not None else 10)
        print(f"restored ARMING_CHECK={getp(b'ARMING_CHECK')} DISARM_DELAY={getp(b'DISARM_DELAY')}")


if __name__ == "__main__":
    main()
