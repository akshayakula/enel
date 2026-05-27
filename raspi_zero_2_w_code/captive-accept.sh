#!/bin/bash
# enel: accept captive portals on guest Wi-Fi (e.g. JBGS-Guest).
# Strategy: probe -> if blocked, GET the portal URL -> probe again; if still
# blocked, find the first <form> and submit it ("click the only button").
set -u

PROBE_URL="http://detectportal.firefox.com/success.txt"
TAG="captive-accept"

nmcli -t -f DEVICE,STATE device status | grep -q '^wlan0:connected$' || exit 0

probe_ok() {
    [ "$(curl -sS -L --max-time 8 "$PROBE_URL" 2>/dev/null)" = "success" ]
}

probe_ok && exit 0

logger -t "$TAG" "probe failed — attempting portal accept"

portal_url="$(curl -sS -L --max-time 8 \
    -o /tmp/captive-portal.html -w '%{url_effective}' "$PROBE_URL" 2>/dev/null || true)"

if [ -z "$portal_url" ] || [ "$portal_url" = "$PROBE_URL" ]; then
    logger -t "$TAG" "no captive redirect — giving up"
    exit 0
fi

logger -t "$TAG" "portal: $portal_url"

sleep 2
if probe_ok; then
    logger -t "$TAG" "authorized via GET"
    exit 0
fi

form_html="$(awk '/<form/{flag=1} flag{print} /<\/form>/{flag=0; exit}' /tmp/captive-portal.html)"
if [ -z "$form_html" ]; then
    logger -t "$TAG" "no form on portal — giving up"
    exit 0
fi

action="$(printf '%s' "$form_html" | grep -oiE 'action="[^"]*"' | head -1 \
    | sed -E 's/^action="(.*)"$/\1/')"
method="$(printf '%s' "$form_html" | grep -oiE 'method="[^"]*"' | head -1 \
    | sed -E 's/^method="(.*)"$/\1/' | tr '[:upper:]' '[:lower:]')"
[ -z "$method" ] && method="get"

case "$action" in
    "")                  submit_url="$portal_url" ;;
    http://*|https://*)  submit_url="$action" ;;
    /*)                  scheme_host="$(printf '%s' "$portal_url" | sed -E 's#^(https?://[^/]+).*#\1#')"
                         submit_url="${scheme_host}${action}" ;;
    *)                   base="$(printf '%s' "$portal_url" | sed -E 's#/[^/]*$#/#')"
                         submit_url="${base}${action}" ;;
esac

data="$(printf '%s' "$form_html" | grep -oiE '<(input|button)[^>]*>' | while IFS= read -r tag; do
    n="$(printf '%s' "$tag" | sed -nE 's/.*name="([^"]*)".*/\1/p')"
    v="$(printf '%s' "$tag" | sed -nE 's/.*value="([^"]*)".*/\1/p')"
    [ -n "$n" ] && printf '%s=%s&' "$n" "$v"
done | sed 's/&$//')"

logger -t "$TAG" "submit: $method $submit_url"

if [ "$method" = "post" ]; then
    curl -sS -L --max-time 10 -o /dev/null -X POST --data "$data" "$submit_url" || true
else
    [ -n "$data" ] && submit_url="${submit_url}?${data}"
    curl -sS -L --max-time 10 -o /dev/null "$submit_url" || true
fi

sleep 1
if probe_ok; then
    logger -t "$TAG" "authorized via form submit"
else
    logger -t "$TAG" "still blocked after submit"
    exit 1
fi
