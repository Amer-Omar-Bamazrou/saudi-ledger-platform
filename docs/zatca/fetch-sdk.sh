#!/usr/bin/env bash
# Fetch and extract ZATCA's Compliance & Enablement Toolbox (SDK).
#
# PUBLIC DOWNLOAD — no sandbox account, no login, no VAT registration.
# Hosted on ZATCA's SharePoint, which 403s a bare curl: a browser User-Agent AND
# a cookie jar are both required (the cookie jar is what actually fixes it — the
# first request sets a session cookie that the redirect to the file needs).
#
# The SDK is gitignored (~40 MB zip, ~90 MB extracted). See sdk-manifest.md for
# the inventory and checksum.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p sdk
cd sdk

URL="https://sadzit.sharepoint.com/:u:/g/EfjCGimzSjNPpVrWgn4f-mgBZ55D3EtCizFD7E8caZ4Kcg?e=gfOEcw&download=1"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ZIP="zatca-envoice-sdk-203.zip"

echo "Downloading ZATCA SDK (~40 MB)..."
curl -sS -L --max-time 600 -A "$UA" -c .cookies -b .cookies -o "$ZIP" "$URL"
rm -f .cookies

# A short file means SharePoint served an error/redirect page, not the archive.
size=$(stat -c%s "$ZIP" 2>/dev/null || stat -f%z "$ZIP")
if [ "$size" -lt 1000000 ]; then
  echo "ERROR: got $size bytes — expected ~40 MB. SharePoint likely served an error page." >&2
  head -c 200 "$ZIP" >&2; echo >&2
  exit 1
fi

echo "Downloaded $size bytes"
sha256sum "$ZIP"
echo "Expected: 1a7df6d91fd34968ad59a97087f637f56504fdf92c42050916b838be20fc5ae3"
echo "  (a mismatch means ZATCA published a new SDK build — re-check the manifest)"

echo "Extracting..."
unzip -q -o "$ZIP" -d extracted
echo "Done: sdk/extracted/zatca-envoice-sdk-203/"
echo
echo "The offline validator needs Java:  Apps/fatoora -validate -invoice <file.xml>"
