#!/usr/bin/env bash
# Fetch the @siglum/engine runtime assets for the ADR-003 spike.
#
# 225 MB unpacked, so they are gitignored rather than committed. Pinned to the
# release the ADR was measured against: an unpinned fetch would silently change
# what the corpus results mean.
set -euo pipefail

VERSION="v0.1.0"
BASE="https://github.com/SiglumProject/siglum-engine/releases/download/${VERSION}"
DEST="public/engines/siglum"

mkdir -p "$DEST"
cd "$DEST"

for file in busytex.js busytex.wasm; do
  [ -f "$file" ] || curl -fsSL -O "${BASE}/${file}"
done

if [ ! -d bundles ]; then
  curl -fsSL -O "${BASE}/siglum-bundles-${VERSION}.tar.gz"
  tar -xzf "siglum-bundles-${VERSION}.tar.gz"
  rm -f "siglum-bundles-${VERSION}.tar.gz"
  # The archive was built on macOS and carries AppleDouble sidecars plus a
  # stray node_modules from the publisher's toolchain.
  find . -name "._*" -delete
  rm -rf bundles/node_modules
fi

# xzwasm is an npm dependency rather than a release asset, but Siglum loads it
# by URL at runtime, so it has to sit alongside the other engine assets.
cd - > /dev/null
XZWASM=$(find node_modules/.pnpm -maxdepth 1 -name "xzwasm@*" | head -1)
if [ -n "$XZWASM" ]; then
  cp "$XZWASM/node_modules/xzwasm/dist/package/xzwasm.min.js" "$DEST/xzwasm.js"
else
  echo "warning: xzwasm not installed; CTAN package decompression will fail" >&2
fi

echo "Siglum ${VERSION} assets ready in ${DEST}"
