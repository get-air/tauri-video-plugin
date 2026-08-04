#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_dir="$script_dir/certs"
mkdir -p "$cert_dir"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \
  -subj '/CN=Tauri Video Qualification CA' \
  -keyout "$cert_dir/ca-key.pem" -out "$cert_dir/ca.pem"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2' \
  -keyout "$cert_dir/server-key.pem" -out "$cert_dir/server.csr"
openssl x509 -req -sha256 -days 7 \
  -in "$cert_dir/server.csr" -CA "$cert_dir/ca.pem" -CAkey "$cert_dir/ca-key.pem" \
  -CAcreateserial -copy_extensions copyall -out "$cert_dir/server.pem"
openssl verify -CAfile "$cert_dir/ca.pem" "$cert_dir/server.pem"
