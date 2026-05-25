#!/bin/bash
# enel: auto-join the strongest OPEN Wi-Fi whose SSID starts with 'J' or 'j'.
# Skipped when wlan0 is already connected — so FUTURE (priority 100) wins
# whenever it's in range.
set -eu

if nmcli -t -f DEVICE,STATE device status | grep -q '^wlan0:connected$'; then
    exit 0
fi

nmcli device wifi rescan 2>/dev/null || true
sleep 4

# Pick the strongest open SSID that starts with J/j.
# nmcli -t output is colon-separated; escape-colons in values appear as \:
best=$(nmcli -t -f SSID,SECURITY,SIGNAL device wifi list --rescan no 2>/dev/null \
    | awk -F: '
        { ssid=$1; sec=$2; sig=$3 }
        ssid == "" { next }
        tolower(substr(ssid,1,1)) != "j" { next }
        (sec == "" || sec == "--") { printf "%s\t%s\n", sig, ssid }
      ' \
    | sort -rn | head -1 | cut -f2-)

if [ -z "$best" ]; then
    exit 0
fi

logger -t wifi-j-autojoin "attempting connect: $best"
if nmcli -w 20 device wifi connect "$best" ifname wlan0 2>&1 \
        | logger -t wifi-j-autojoin; then
    logger -t wifi-j-autojoin "connected: $best"
fi
