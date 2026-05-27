#!/usr/bin/env python3
"""
Robust IMU (gyro + accelerometer) calibration driver for ArduPilot over MAVLink.

Hard-won protocol facts (ArduCopter 4.6.x, verified empirically):
  * ArduPilot only streams cal text to a LIVE GCS link -> send GCS heartbeats.
  * Start from a CLEAN state. Repeated start/abort cycles wedge the calibrator
    (positions then return FAILED). So we REBOOT the FC, then start cal once.
  * This firmware sends ONE prompt ("Place vehicle level and press any key") at
    the start and then does NOT prompt between orientations. The GCS must drive
    positions 1..6 in sequence. Each MAV_CMD_ACCELCAL_VEHICLE_POS is sent ONCE;
    the first returns ACCEPTED (sample collected), resending the same position
    returns FAILED. So: send once, confirm ACCEPTED, move to the next position.
  * A FAILED ack usually means the board was moving when sampled -> we retry the
    SAME position after a short pause (board must be held still).

Driving it (turn-by-turn — YOU physically rotate the board):
  Status tokens on stdout:
    AWAITING <pos> <name>     -> put the board in <name> and confirm
    ACK <pos> <RESULT>        -> the FC's response to that position
    CAPTURED <name>           -> accepted; move to the next orientation
    RESULT SUCCESS|FAILED     -> finished
  Confirm board is in the requested orientation:  echo go    > /tmp/imu_cal_cmd
  Abort:                                          echo abort > /tmp/imu_cal_cmd

Usage:  python3 imu_cal.py [--skip-gyro] [--no-reboot]
"""
import sys, time, glob
from pymavlink import mavutil

CMD_FILE = "/tmp/imu_cal_cmd"
ACCELCAL_VEHICLE_POS = 42429
POSITIONS = [
    (1, "LEVEL (flat, upright)"),
    (2, "LEFT side (rolled 90 left)"),
    (3, "RIGHT side (rolled 90 right)"),
    (4, "NOSE DOWN (pitched down 90)"),
    (5, "NOSE UP (pitched up 90)"),
    (6, "ON ITS BACK (upside down)"),
]


def srecv(m, **kw):
    try:
        return m.recv_match(**kw)
    except TypeError:
        return None


def read_cmd():
    try:
        return open(CMD_FILE).read().strip().lower()
    except Exception:
        return ""


def clear_cmd():
    try:
        open(CMD_FILE, "w").write("")
    except Exception:
        pass


def connect():
    devs = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not devs:
        print("ERROR no /dev/cu.usbmodem* device", flush=True); sys.exit(1)
    m = mavutil.mavlink_connection(devs[0], baud=115200,
                                   source_system=255, source_component=190)
    t0 = time.time()
    while time.time() - t0 < 15:
        if srecv(m, type='HEARTBEAT', blocking=True, timeout=2):
            return m
    print("ERROR no heartbeat", flush=True); sys.exit(1)


def hb(m):
    m.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS,
                         mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)


def drain_text(m, secs):
    """Pump heartbeats + print FC text for `secs`; return list of texts seen."""
    seen = []
    t0 = time.time(); last = 0
    while time.time() - t0 < secs:
        if time.time() - last > 1:
            last = time.time(); hb(m)
        msg = srecv(m, blocking=True, timeout=0.2)
        if msg and msg.get_type() == 'STATUSTEXT' and 'home' not in msg.text:
            print("FC:", msg.text, flush=True); seen.append(msg.text)
    return seen


def gyro_cal(m, tgt):
    print("GYRO start (hold still ~5s)...", flush=True)
    m.mav.command_long_send(tgt[0], tgt[1],
        mavutil.mavlink.MAV_CMD_PREFLIGHT_CALIBRATION, 0, 1,0,0,0,0,0,0)
    drain_text(m, 7)
    print("GYRO done", flush=True)


def send_pos_until_ack(m, tgt, pos, attempts=5):
    """Send one position; wait for ACCEPTED. Retry on FAILED/no-ack (board must
    be held still). Returns True on ACCEPTED."""
    for a in range(attempts):
        m.mav.command_long_send(tgt[0], tgt[1], ACCELCAL_VEHICLE_POS,
                                a, pos, 0,0,0,0,0,0)
        t0 = time.time(); last = 0
        while time.time() - t0 < 2.5:
            if time.time() - last > 1:
                last = time.time(); hb(m)
            msg = srecv(m, blocking=True, timeout=0.2)
            if not msg:
                continue
            mt = msg.get_type()
            if mt == 'COMMAND_ACK' and msg.command == ACCELCAL_VEHICLE_POS:
                res = mavutil.mavlink.enums['MAV_RESULT'][msg.result].name
                print(f"ACK {pos} {res}", flush=True)
                if msg.result == mavutil.mavlink.MAV_RESULT_ACCEPTED:
                    return True
                break  # FAILED -> retry after short pause
            elif mt == 'STATUSTEXT' and 'home' not in msg.text:
                print("FC:", msg.text, flush=True)
                if 'successful' in msg.text.lower():
                    return True
        time.sleep(1.0)  # let the board settle before retrying
    return False


def accel_cal(m, tgt):
    clear_cmd()
    print("ACCEL start...", flush=True)
    m.mav.command_long_send(tgt[0], tgt[1],
        mavutil.mavlink.MAV_CMD_PREFLIGHT_CALIBRATION, 0, 0,0,0,0,1,0,0)
    # confirm the cal actually entered the waiting state
    seen = drain_text(m, 6)
    if not any('place' in s.lower() for s in seen):
        print("WARN: no 'Place vehicle level' prompt seen — cal may not have started", flush=True)

    for pos, name in POSITIONS:
        print(f"AWAITING {pos} {name}", flush=True)
        # wait for user to confirm the orientation
        while True:
            cmd = read_cmd()
            if cmd == "abort":
                print("RESULT ABORTED", flush=True); return False
            if cmd == "go":
                clear_cmd(); break
            hb(m)
            srecv(m, blocking=True, timeout=0.3)  # keep link drained
        print(f"CONFIRMED {name}", flush=True)
        ok = send_pos_until_ack(m, tgt, pos)
        if not ok:
            print(f"RESULT FAILED (position {pos} not accepted)", flush=True)
            return False
        print(f"CAPTURED {name}", flush=True)

    # after the 6th, the FC computes and reports result
    print("computing calibration...", flush=True)
    seen = drain_text(m, 8)
    if any('successful' in s.lower() for s in seen):
        print("RESULT SUCCESS", flush=True); return True
    if any('failed' in s.lower() for s in seen):
        print("RESULT FAILED", flush=True); return False
    print("RESULT UNKNOWN (no final message)", flush=True); return False


def main():
    skip_gyro = "--skip-gyro" in sys.argv
    no_reboot = "--no-reboot" in sys.argv
    m = connect(); tgt = (m.target_system, 1)
    if not no_reboot:
        print("REBOOT for clean cal state...", flush=True)
        m.mav.command_long_send(tgt[0], tgt[1],
            mavutil.mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 0, 1,0,0,0,0,0,0)
        m.close(); time.sleep(13)
        m = connect(); tgt = (m.target_system, 1)
    print("CONNECTED", flush=True)
    for _ in range(8):
        hb(m); time.sleep(0.3)
    if not skip_gyro:
        gyro_cal(m, tgt); time.sleep(1)
    ok = accel_cal(m, tgt)
    print("DONE", "OK" if ok else "NOT-OK", flush=True)


if __name__ == "__main__":
    main()
