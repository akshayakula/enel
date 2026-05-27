#!/usr/bin/env python3
"""enel pi-control: tiny HTTP control plane.

Exposes a handful of read/write endpoints on port 8088 so the dashboard can:
  - read live status (CPU temp, uptime, streamer/ring service state)
  - override the NeoPixel ring (identify blink, solid color, or clear)

Writes override state to /run/ring-override.json which ring.py polls each tick.
Stdlib only — no Flask dep needed on a Pi Zero.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

PORT = 8088
OVERRIDE_PATH = "/run/ring-override.json"
MAX_TTL_SECONDS = 3600
CONF_PATH = "/boot/firmware/streamer.conf"
COMMAND_STATE_PATH = "/var/lib/enel/command-state.json"
COMMAND_POLL_SECONDS = 1.5
DEFAULT_REMOTE_DASHBOARD = "https://enel-stream.fly.dev"


def _systemctl_active(unit: str) -> bool:
    return subprocess.run(
        ["systemctl", "is-active", "--quiet", unit]
    ).returncode == 0


def _read_cpu_temp_c() -> float | None:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read().strip()) / 1000.0
    except OSError:
        return None


def _read_uptime_s() -> float | None:
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError):
        return None


def _read_hostname() -> str:
    try:
        with open("/etc/hostname") as f:
            return f.read().strip()
    except OSError:
        return "unknown"


def _write_override(payload: dict) -> None:
    tmp = OVERRIDE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, OVERRIDE_PATH)


def _clear_override() -> None:
    try:
        os.remove(OVERRIDE_PATH)
    except FileNotFoundError:
        pass


def _read_streamer_conf() -> dict[str, str]:
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


def _dashboard_urls(conf: dict[str, str]) -> list[str]:
    urls: list[str] = []
    raw = conf.get("COMMAND_SERVERS") or conf.get("DASHBOARD_URLS") or ""
    for part in raw.replace(",", " ").split():
        if part:
            urls.append(part.rstrip("/"))

    host = conf.get("SERVER_HOST", "")
    if host:
        if host.endswith(".fly.dev"):
            urls.append(f"https://{host}".rstrip("/"))
        elif "." in host:
            urls.append(f"http://{host}:3605".rstrip("/"))

    urls.append(DEFAULT_REMOTE_DASHBOARD)

    out: list[str] = []
    seen = set()
    for url in urls:
        if not url.startswith(("http://", "https://")):
            url = f"https://{url}"
        url = url.rstrip("/")
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _read_command_state() -> dict:
    try:
        with open(COMMAND_STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_command_state(state: dict) -> None:
    path = Path(COMMAND_STATE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def _apply_ring_command(cmd: str, args: dict) -> bool:
    if cmd == "identify":
        _write_override({
            "mode":       "identify",
            "expires_at": time.time() + _clamp_ttl(args.get("ttl", 5), default=5),
        })
        return True

    if cmd == "color":
        _write_override({
            "mode":       "solid",
            "r":          _clamp_byte(args.get("r")),
            "g":          _clamp_byte(args.get("g")),
            "b":          _clamp_byte(args.get("b")),
            "expires_at": time.time() + _clamp_ttl(args.get("ttl", 60)),
        })
        return True

    if cmd == "compass":
        try:
            bearing = float(args.get("bearing_deg", 0.0)) % 360.0
        except (TypeError, ValueError):
            bearing = 0.0
        try:
            width = int(args.get("width", 3))
        except (TypeError, ValueError):
            width = 3
        payload = {
            "mode":         "compass",
            "bearing_deg":  bearing,
            "width":        max(1, min(16, width)),
            "r":            _clamp_byte(args.get("r", 0)),
            "g":            _clamp_byte(args.get("g", 0)),
            "b":            _clamp_byte(args.get("b", 0)),
            "expires_at":   time.time() + _clamp_ttl(args.get("ttl", 300)),
        }
        if "count" in args:
            try:
                c = int(args.get("count"))
            except (TypeError, ValueError):
                c = 3
            payload["count"] = max(1, min(16, c))
        if args.get("on_target"):
            payload["on_target"] = True
        _write_override(payload)
        return True

    if cmd == "clear":
        _clear_override()
        return True

    return False


def _command_poller() -> None:
    conf = _read_streamer_conf()
    stream_id = conf.get("STREAM_ID", "")
    if not stream_id:
        return

    state = _read_command_state()
    state_key = f"last_ts:{stream_id}"
    last_ts = float(state.get(state_key, 0) or 0)
    urls = _dashboard_urls(conf)

    while True:
        for base_url in urls:
            try:
                req = Request(f"{base_url}/api/command/{stream_id}", headers={"accept": "application/json"})
                with urlopen(req, timeout=5) as res:
                    payload = json.load(res)
            except (OSError, URLError, TimeoutError, ValueError):
                continue

            ts = float(payload.get("ts", 0) or 0)
            cmd = payload.get("cmd")
            args = payload.get("args") if isinstance(payload.get("args"), dict) else {}
            if not cmd or ts <= last_ts:
                continue

            last_ts = ts
            state[state_key] = last_ts
            _write_command_state(state)
            if _apply_ring_command(str(cmd), args):
                print(f"command-poller: applied {cmd} from {base_url}", flush=True)
        time.sleep(COMMAND_POLL_SECONDS)


def _current_override() -> dict | None:
    try:
        with open(OVERRIDE_PATH) as f:
            o = json.load(f)
    except (OSError, ValueError):
        return None
    if o.get("expires_at", 0) < time.time():
        return None
    return o


def _clamp_byte(v) -> int:
    try:
        v = int(v)
    except (TypeError, ValueError):
        return 0
    return max(0, min(255, v))


def _clamp_ttl(v, default: int = 30) -> int:
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(1, min(MAX_TTL_SECONDS, v))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep journal quiet
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        if self.path == "/status":
            override = _current_override()
            return self._json(200, {
                "hostname":        _read_hostname(),
                "uptime_s":        _read_uptime_s(),
                "cpu_temp_c":      _read_cpu_temp_c(),
                "streamer_active": _systemctl_active("streamer.service"),
                "ring_active":     _systemctl_active("ring.service"),
                "ring_override":   override,
                "ts":              time.time(),
            })
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/ring/identify":
            body = self._read_body()
            ttl = _clamp_ttl(body.get("ttl", 5), default=5)
            _write_override({
                "mode":       "identify",
                "expires_at": time.time() + ttl,
            })
            return self._json(200, {"ok": True, "ttl": ttl})

        if self.path == "/ring/color":
            body = self._read_body()
            _write_override({
                "mode":       "solid",
                "r":          _clamp_byte(body.get("r")),
                "g":          _clamp_byte(body.get("g")),
                "b":          _clamp_byte(body.get("b")),
                "expires_at": time.time() + _clamp_ttl(body.get("ttl", 60)),
            })
            return self._json(200, {"ok": True})

        if self.path == "/ring/compass":
            body = self._read_body()
            try:
                bearing = float(body.get("bearing_deg", 0.0)) % 360.0
            except (TypeError, ValueError):
                bearing = 0.0
            try:
                width = int(body.get("width", 3))
            except (TypeError, ValueError):
                width = 3
            width = max(1, min(16, width))
            payload = {
                "mode":         "compass",
                "bearing_deg":  bearing,
                "width":        width,
                "r":            _clamp_byte(body.get("r", 0)),
                "g":            _clamp_byte(body.get("g", 0)),
                "b":            _clamp_byte(body.get("b", 0)),
                "expires_at":   time.time() + _clamp_ttl(body.get("ttl", 300)),
            }
            if "count" in body:
                try:
                    c = int(body.get("count"))
                except (TypeError, ValueError):
                    c = 3
                payload["count"] = max(1, min(16, c))
            if body.get("on_target"):
                payload["on_target"] = True
            _write_override(payload)
            return self._json(200, {"ok": True, "bearing_deg": bearing})

        if self.path == "/ring/clear":
            _clear_override()
            return self._json(200, {"ok": True})

        if self.path == "/system/poweroff":
            # Service runs as root, so this works without sudo. Delay so the
            # HTTP response gets flushed before the kernel halts.
            subprocess.Popen(
                ["/bin/sh", "-c", "sleep 1 && /sbin/poweroff"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return self._json(200, {"ok": True, "action": "poweroff"})

        if self.path == "/system/reboot":
            subprocess.Popen(
                ["/bin/sh", "-c", "sleep 1 && /sbin/reboot"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return self._json(200, {"ok": True, "action": "reboot"})

        return self._json(404, {"error": "not found"})


def main():
    threading.Thread(target=_command_poller, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
