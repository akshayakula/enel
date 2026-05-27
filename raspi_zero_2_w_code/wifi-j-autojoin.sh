#!/bin/bash
# enel: keep the Pi reachable by preferring the operator iPhone hotspot, then
# fall back to the strongest open Wi-Fi whose SSID starts with 'J' or 'j'.
set -eu

HOTSPOT_SSID="Akshay's Iphone"
HOTSPOT_PASSWORD="Sidsacapper"

if ! nmcli -t -f NAME connection show | grep -Fxq "$HOTSPOT_SSID"; then
    nmcli connection add type wifi ifname wlan0 con-name "$HOTSPOT_SSID" ssid "$HOTSPOT_SSID" 2>&1 \
        | logger -t wifi-j-autojoin || true
    nmcli connection modify "$HOTSPOT_SSID" \
        wifi-sec.key-mgmt wpa-psk \
        wifi-sec.psk "$HOTSPOT_PASSWORD" \
        connection.autoconnect yes \
        connection.autoconnect-priority 90 2>&1 \
        | logger -t wifi-j-autojoin || true
fi

active_ssid="$(iwgetid -r 2>/dev/null || true)"
if [ "$active_ssid" = "$HOTSPOT_SSID" ]; then
    exit 0
fi

nmcli device wifi rescan 2>/dev/null || true
sleep 4

if nmcli -w 20 connection up "$HOTSPOT_SSID" ifname wlan0 2>&1 \
        | logger -t wifi-j-autojoin; then
    logger -t wifi-j-autojoin "connected hotspot: $HOTSPOT_SSID"
    exit 0
fi

if nmcli -t -f DEVICE,STATE device status | grep -q '^wlan0:connected$'; then
    exit 0
fi

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
