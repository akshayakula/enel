#!/usr/bin/env python3
"""enel battery telemetry: INA219 UPS HAT -> dashboard battery badge."""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.request

CONF_PATH = "/boot/firmware/streamer.conf"
INA219_BUS = 1
INA219_ADDRS = (0x43, 0x42, 0x41, 0x40)
INA219_REG_CONFIG = 0x00
INA219_REG_SHUNT = 0x01
INA219_REG_BUSV = 0x02
BATT_V_EMPTY = 3.0
BATT_V_FULL = 4.2

INTERVAL = float(os.environ.get("BATT_INTERVAL", "5"))

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def _swap16(word: int) -> int:
    return ((word & 0xFF) << 8) | (word >> 8)


def _read_conf() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        with open(CONF_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def _targets(conf: dict[str, str]) -> list[str]:
    raw = os.environ.get("BATT_TARGETS") or conf.get("COMMAND_SERVERS") or ""
    urls = [part.strip().rstrip("/") for part in raw.replace(",", " ").split() if part.strip()]
    if "https://enel-stream.fly.dev" not in urls:
        urls.append("https://enel-stream.fly.dev")
    return list(dict.fromkeys(urls))


def _bus_module():
    try:
        import smbus2
        return smbus2
    except ImportError:
        import smbus
        return smbus


def read_battery() -> dict:
    smbus_mod = _bus_module()
    bus = smbus_mod.SMBus(INA219_BUS)
    addr = None
    try:
        for candidate in INA219_ADDRS:
            try:
                bus.read_word_data(candidate, INA219_REG_CONFIG)
                addr = candidate
                break
            except OSError:
                continue
        if addr is None:
            raise RuntimeError("INA219 not found")

        voltage = (_swap16(bus.read_word_data(addr, INA219_REG_BUSV)) >> 3) * 0.004
        raw_shunt = _swap16(bus.read_word_data(addr, INA219_REG_SHUNT))
        if raw_shunt > 0x7FFF:
            raw_shunt -= 0x10000
    finally:
        try:
            bus.close()
        except Exception:
            pass

    pct = (voltage - BATT_V_EMPTY) / (BATT_V_FULL - BATT_V_EMPTY) * 100.0
    pct = max(0.0, min(100.0, pct))
    return {
        "voltage": round(voltage, 2),
        "pct": round(pct),
        "charging": raw_shunt > 50,
    }


def post(base_url: str, cam: str, payload: dict) -> bool:
    req = urllib.request.Request(
        f"{base_url}/api/battery/{cam}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5, context=_CTX).read()
        return True
    except Exception:
        return False


def main() -> None:
    conf = _read_conf()
    cam = os.environ.get("STREAM_ID") or conf.get("STREAM_ID") or "cam1"
    targets = _targets(conf)
    print(f"batt-telemetry: cam={cam} targets={targets} interval={INTERVAL}s", flush=True)
    while True:
        try:
            payload = read_battery()
            ok = [target for target in targets if post(target, cam, payload)]
            print(f"batt-telemetry: {payload} -> {len(ok)}/{len(targets)} ok", flush=True)
        except Exception as exc:
            print(f"batt-telemetry: read/post error {exc}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
