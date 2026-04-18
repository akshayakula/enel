#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/certs"
KEY_FILE="${CERT_DIR}/dev-key.pem"
CERT_FILE="${CERT_DIR}/dev-cert.pem"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "${LAN_IP}" ]; then
  LAN_IP="127.0.0.1"
fi

mkdir -p "${CERT_DIR}"

TMP_CONFIG="$(mktemp)"
trap 'rm -f "${TMP_CONFIG}"' EXIT

cat > "${TMP_CONFIG}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
C = US
ST = NY
L = New York
O = Enel Local Dev
OU = WebRTC
CN = ${LAN_IP}

[v3_req]
subjectAltName = @alt_names
extendedKeyUsage = serverAuth

[alt_names]
IP.1 = ${LAN_IP}
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

openssl req \
  -x509 \
  -nodes \
  -days 365 \
  -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -config "${TMP_CONFIG}"

echo "Generated:"
echo "  ${CERT_FILE}"
echo "  ${KEY_FILE}"
echo
echo "LAN IP in certificate: ${LAN_IP}"
