#!/usr/bin/env bash
# Fetch the ZATCA Phase 2 reference specifications into ./specs/.
#
# The PDFs are gitignored (large vendor binaries). Run this after a fresh clone.
# Checksums are printed at the end — compare them against the table in README.md.
# A CHANGED CHECKSUM MEANS ZATCA REVISED THE DOCUMENT: read the diff before
# assuming the implementation is still compliant.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p specs

ZATCA_DOCS=(
  "https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf"
  "https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf"
  "https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf"
  "https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/Fatoora_Portal_User_Manual_English.pdf"
  "https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/QRCodeCreation.pdf"
)

for url in "${ZATCA_DOCS[@]}"; do
  name="$(basename "$url")"
  printf '%-70s ' "$name"
  curl -sS -L --max-time 180 -o "specs/$name" "$url" && echo "ok"
done

# The sandbox portal serves its own, more frequently updated, manual.
printf '%-70s ' "sandbox_Developer_Portal_User_Manual.pdf"
curl -sS -L --max-time 180 \
  -o "specs/sandbox_Developer_Portal_User_Manual.pdf" \
  "https://sandbox.zatca.gov.sa/20220623_Developer%20Portal%20User%20Manual_vF.pdf" && echo "ok"

echo
echo "--- SHA-256 (compare against README.md) ---"
sha256sum specs/*.pdf

echo
echo "--- ZATCA server publication dates ---"
for url in "${ZATCA_DOCS[@]}"; do
  printf '%-70s ' "$(basename "$url")"
  curl -sSI -L --max-time 60 "$url" | grep -i '^last-modified' || echo "(none)"
done
