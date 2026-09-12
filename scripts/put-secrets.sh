#!/bin/sh
# Sube los certificados como secrets del Worker (base64 de los PEM en certs/). Requiere `npx wrangler login`.
set -e
cd "$(dirname "$0")/.."
for pair in WWDR_PEM_B64:wwdr SIGNER_CERT_PEM_B64:signerCert SIGNER_KEY_PEM_B64:signerKey; do
  name="${pair%%:*}"; file="certs/${pair##*:}.pem"
  base64 -i "$file" | tr -d '\n' | npx wrangler secret put "$name"
done
