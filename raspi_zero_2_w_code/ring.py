#!/usr/bin/env python3
# enel NeoPixel 16-ring lifecycle indicator.
# Ring hardware: SK6812 RGBW 16-pixel ring (W28666-C). 4 bytes/LED, GRBW order.
# LED 0 is physical north. Brightness is hard-capped; colors are gamma-corrected.
# On power-on it reads the UPS HAT's INA219 over I2C and shows a battery gauge
# before the lifecycle loop. Once streaming, LED 0 stays red as the north marker.
import json
import math
import os
import signal
import subprocess
import sys
import time

from rpi_ws281x import PixelStrip, Color, ws

NUM_LEDS     = 16
GPIO_PIN     = 18      # PWM0 — requires dtparam=audio=off
LED_FREQ_HZ  = 800000
LED_DMA      = 10
LED_INVERT   = False
LED_CHANNEL  = 0
LED_STRIP    = ws.SK6812_STRIP_GRBW  # RGBW ring (4 bytes/LED)
MAX_BRIGHT   = 32      # hard cap (~12.5%) — safe off Pi 5V rail
GAMMA        = 2.2
NORTH_LED    = 0
OVERRIDE_PATH = "/run/ring-override.json"

# --- INA219 / UPS HAT battery -------------------------------------------------
INA219_BUS        = 1                  # GPIO header I2C bus (needs dtparam=i2c_arm=on)
INA219_ADDRS      = (0x43, 0x42, 0x41, 0x40)
INA219_REG_CONFIG = 0x00
INA219_REG_SHUNT  = 0x01
INA219_REG_BUSV   = 0x02
BATT_V_EMPTY      = 3.0   # Li-ion ~empty
BATT_V_FULL       = 4.2   # Li-ion ~full


def _swap16(word):
    return ((word & 0xFF) << 8) | (word >> 8)


def read_battery():
    """Return (voltage, percent, charging) from the INA219, or None if absent."""
    try:
        import smbus2
    except ImportError:
        return None
    try:
        bus = smbus2.SMBus(INA219_BUS)
    except (FileNotFoundError, OSError):
        return None
    addr = None
    try:
        for a in INA219_ADDRS:
            try:
                bus.read_word_data(a, INA219_REG_CONFIG)
                addr = a
                break
            except OSError:
                continue
        if addr is None:
            return None
        raw_bus = _swap16(bus.read_word_data(addr, INA219_REG_BUSV))
        voltage = (raw_bus >> 3) * 0.004
        raw_sh = _swap16(bus.read_word_data(addr, INA219_REG_SHUNT))
        if raw_sh > 0x7FFF:
            raw_sh -= 0x10000
        charging = raw_sh > 50
    except OSError:
        return None
    finally:
        try:
            bus.close()
        except Exception:
            pass
    pct = (voltage - BATT_V_EMPTY) / (BATT_V_FULL - BATT_V_EMPTY) * 100.0
    pct = max(0.0, min(100.0, pct))
    return (voltage, pct, charging)


def level_rgb(pct):
    if pct > 50:
        return (0.0, 1.0, 0.0)
    if pct >= 20:
        return (1.0, 0.45, 0.0)
    return (1.0, 0.0, 0.0)


def gamma_byte(v):
    v = max(0.0, min(1.0, v))
    return int(round((v ** GAMMA) * 255))


def rgb(r, g, b, scale=1.0):
    return Color(gamma_byte(r * scale), gamma_byte(g * scale), gamma_byte(b * scale))


def wifi_up():
    try:
        with open("/sys/class/net/wlan0/operstate") as f:
            return f.read().strip() == "up"
    except OSError:
        return False


def streamer_active():
    return subprocess.run(["systemctl", "is-active", "--quiet", "streamer.service"]).returncode == 0


def streamer_failed():
    return subprocess.run(["systemctl", "is-failed", "--quiet", "streamer.service"]).returncode == 0


def mark_north(strip):
    # Persistent orientation marker. User aligns the ring so this LED points
    # true north; all other effects are read relative to it.
    strip.setPixelColor(NORTH_LED, rgb(1.0, 0.0, 0.0, 0.35))


def clear(strip):
    for i in range(NUM_LEDS):
        strip.setPixelColor(i, 0)
    mark_north(strip)
    strip.show()


def battery_intro(strip, pct, charging, duration_fill=1.6, duration_hold=1.5):
    n = int(round(pct / 100.0 * NUM_LEDS))
    if pct > 0:
        n = max(1, n)
    r, g, b = level_rgb(pct)

    step = duration_fill / max(n, 1)
    for k in range(n):
        strip.setPixelColor(k, rgb(r, g, b, 0.85))
        strip.show()
        time.sleep(step)

    t0 = time.monotonic()
    while time.monotonic() - t0 < duration_hold:
        t = time.monotonic() - t0
        breathe = 0.55 + 0.30 * (0.5 + 0.5 * math.sin(t * 3.0))
        spark = int((t * 10) % NUM_LEDS) if charging else -1
        for i in range(NUM_LEDS):
            if i < n:
                lvl = breathe
                if i == spark:
                    lvl = min(1.0, breathe + 0.4)
                strip.setPixelColor(i, rgb(r, g, b, lvl))
            else:
                strip.setPixelColor(i, 0)
        strip.show()
        time.sleep(1.0 / 60.0)
    clear(strip)


def boot_wipe(strip, duration=1.2):
    steps = NUM_LEDS
    step_time = duration * 0.6 / steps
    for i in range(steps):
        strip.setPixelColor(i, rgb(1, 1, 1, 0.5))
        strip.show()
        time.sleep(step_time)
    fade_steps = 20
    for s in range(fade_steps, 0, -1):
        lvl = (s / fade_steps) * 0.5
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(1, 1, 1, lvl))
        strip.show()
        time.sleep(duration * 0.4 / fade_steps)
    clear(strip)


def render(strip, mode, t):
    if mode == "wifi_wait":
        head = int((t * 8) % NUM_LEDS)
        for i in range(NUM_LEDS):
            d = min((i - head) % NUM_LEDS, (head - i) % NUM_LEDS)
            lvl = max(0.0, 1.0 - d / 3.0) * 0.6
            strip.setPixelColor(i, rgb(1.0, 0.45, 0.0, lvl))
    elif mode == "connecting":
        head = int((t * 10) % NUM_LEDS)
        for i in range(NUM_LEDS):
            d = min((i - head) % NUM_LEDS, (head - i) % NUM_LEDS)
            lvl = max(0.0, 1.0 - d / 2.5) * 0.7
            strip.setPixelColor(i, rgb(0.0, 0.8, 1.0, lvl))
    elif mode == "idle":
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, 0)
    elif mode == "warn":
        b = 0.15 + 0.45 * (0.5 + 0.5 * math.sin(t * 3.5))
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(1.0, 0.0, 0.0, b))
    elif mode == "fatal":
        on = int(t * 4) % 2 == 0
        lvl = 0.9 if on else 0.0
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(1.0, 0.0, 0.0, lvl))
    else:
        clear(strip)
        return
    mark_north(strip)
    strip.show()


def pick_mode():
    if not wifi_up():
        return "wifi_wait"
    if streamer_failed():
        return "warn"
    if streamer_active():
        return "idle"
    return "connecting"


# Override file schema — written atomically by pi-control.
#   {"mode": "solid"|"identify"|"clear", "r": 0-255, "g": 0-255, "b": 0-255, "expires_at": epoch_seconds}
# "clear" (or missing/expired file) means "use the automatic state machine".
_override_mtime = 0.0
_override_cached = None

def read_override():
    """Cheap disk check; only reparse when mtime changes. Returns (mode, r, g, b) or None."""
    global _override_mtime, _override_cached
    try:
        st = os.stat(OVERRIDE_PATH)
    except FileNotFoundError:
        _override_cached = None
        return None
    if st.st_mtime != _override_mtime:
        _override_mtime = st.st_mtime
        try:
            with open(OVERRIDE_PATH) as f:
                _override_cached = json.load(f)
        except (OSError, ValueError):
            _override_cached = None
    o = _override_cached
    if not o:
        return None
    if o.get("mode") == "clear":
        return None
    if o.get("expires_at", 0) < time.time():
        return None
    return o


def render_override(strip, o, t):
    mode = o.get("mode", "solid")
    r = o.get("r", 0) / 255.0
    g = o.get("g", 0) / 255.0
    b = o.get("b", 0) / 255.0
    if mode == "identify":
        # Bright pulsing beacon — ignore custom color, always a locator cyan-white.
        lvl = 0.6 + 0.4 * (0.5 + 0.5 * math.sin(t * 6.0))
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(0.2, 1.0, 1.0, lvl))
    elif mode == "compass":
        # Range-scaled compass arc.
        # - on_target=True  → whole ring green, dim (power cap). No north marker.
        # - else            → `count` LEDs centered on bearing_deg, rest dark.
        # Back-compat: if count missing, fall back to `width` Gaussian falloff.
        on_target = bool(o.get("on_target", False))
        bearing   = float(o.get("bearing_deg", 0.0)) % 360.0
        target    = bearing / 360.0 * NUM_LEDS
        pulse     = 0.8 + 0.2 * (0.5 + 0.5 * math.sin(t * 3.0))

        if on_target:
            # Full ring green, ~50% of MAX_BRIGHT → ~4% duty → ~200-300 mA total.
            glow = 0.45 + 0.15 * (0.5 + 0.5 * math.sin(t * 2.5))
            for i in range(NUM_LEDS):
                strip.setPixelColor(i, rgb(0.0, 1.0, 0.2, glow))
            strip.show()
            return  # skip mark_north — all-green overrides orientation marker

        if "count" in o:
            try:
                count = int(o.get("count", 3))
            except (TypeError, ValueError):
                count = 3
            count = max(1, min(NUM_LEDS, count))

            if r == 0 and g == 0 and b == 0:
                # Blend accent → green as the arc fills up (proximity cue).
                tgt  = count / NUM_LEDS
                r = 0.71 * (1 - tgt) + 0.00 * tgt
                g = 0.82 * (1 - tgt) + 1.00 * tgt
                b = 0.43 * (1 - tgt) + 0.20 * tgt

            half_f = count / 2.0
            for i in range(NUM_LEDS):
                d = min((i - target) % NUM_LEDS, (target - i) % NUM_LEDS)
                if d <= half_f:
                    lvl = max(0.25, 1.0 - (d / max(half_f, 0.5)) * 0.6) * pulse
                    strip.setPixelColor(i, rgb(r, g, b, lvl))
                else:
                    strip.setPixelColor(i, 0)
        else:
            if r == 0 and g == 0 and b == 0:
                r, g, b = 0.71, 0.82, 0.43
            width = max(1.0, float(o.get("width", 3)))
            half  = width / 2.0
            for i in range(NUM_LEDS):
                d = min((i - target) % NUM_LEDS, (target - i) % NUM_LEDS)
                if d <= half:
                    lvl = max(0.05, 1.0 - (d / half)) * pulse
                    strip.setPixelColor(i, rgb(r, g, b, lvl))
                else:
                    strip.setPixelColor(i, 0)
    else:
        for i in range(NUM_LEDS):
            strip.setPixelColor(i, rgb(r, g, b, 1.0))
    mark_north(strip)
    strip.show()


def main():
    strip = PixelStrip(NUM_LEDS, GPIO_PIN, LED_FREQ_HZ, LED_DMA,
                       LED_INVERT, MAX_BRIGHT, LED_CHANNEL, LED_STRIP)
    strip.begin()

    # Make sure the LEDs are dark on clean exit — systemd sends SIGTERM at
    # shutdown and otherwise the ring holds its last rendered frame until
    # power is physically removed.
    def _exit(_sig, _frame):
        try:
            clear(strip)
        finally:
            sys.exit(0)
    signal.signal(signal.SIGTERM, _exit)
    signal.signal(signal.SIGINT, _exit)

    batt = None
    try:
        batt = read_battery()
    except Exception:
        batt = None
    if batt is not None:
        voltage, pct, charging = batt
        print("ring: battery %.2fV %.0f%% %s"
              % (voltage, pct, "charging" if charging else "discharging"),
              flush=True)
        battery_intro(strip, pct, charging)
    else:
        print("ring: no INA219 detected - fallback boot wipe", flush=True)
        boot_wipe(strip)
    start = time.monotonic()
    last_state_check = 0.0
    mode = "wifi_wait"
    try:
        while True:
            now = time.monotonic()
            if now - last_state_check > 0.5:
                mode = pick_mode()
                last_state_check = now
            override = read_override()
            if override:
                render_override(strip, override, now - start)
            else:
                render(strip, mode, now - start)
            time.sleep(1.0 / 60.0)
    except Exception:
        t0 = time.monotonic()
        while True:
            render(strip, "fatal", time.monotonic() - t0)
            time.sleep(1.0 / 30.0)


if __name__ == "__main__":
    main()
