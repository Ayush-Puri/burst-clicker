#!/bin/bash
# Build a shareable zip of the extension into ~/Downloads.
# Ships only what Chrome needs plus the two docs; leaves the test harness out.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
NAME="burst-clicker-v${VERSION}"
STAGE=$(mktemp -d)
OUT="${HOME}/Downloads/${NAME}.zip"

mkdir -p "${STAGE}/burst-clicker"
for item in manifest.json service-worker.js lib content popup icons INSTALL.txt GUIDE.html; do
  cp -R "$item" "${STAGE}/burst-clicker/"
done
rm -f "${STAGE}/burst-clicker/icons/make_icons.py"
find "${STAGE}" -name '.DS_Store' -delete

rm -f "$OUT"
# -X drops macOS resource forks so the friend does not get __MACOSX noise.
(cd "$STAGE" && zip -qrX "$OUT" burst-clicker)
rm -rf "$STAGE"

echo "$OUT"
unzip -l "$OUT" | tail -n 3
