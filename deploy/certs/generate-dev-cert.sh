#!/bin/sh
# Self-signed certificate for the lab (ECDSA P-256, 1 year).
# In production use a real certificate, for example Let's Encrypt with certbot.
set -e
cd "$(dirname "$0")"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout kidsway.key -out kidsway.crt -days 365 \
  -subj "/CN=kidsway.lab" -addext "subjectAltName=DNS:kidsway.lab,DNS:localhost,IP:127.0.0.1,IP:192.168.56.10"
chmod 600 kidsway.key
echo "Created kidsway.crt and kidsway.key"
