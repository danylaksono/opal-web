#!/usr/bin/env bash
# Fetch the texlyre-busytex runtime assets for the ADR-003 comparison.
#
# 700 MB unpacked, so they are gitignored rather than committed. Pinned to the
# release the ADR was measured against: the assets carry the TeX Live tree, so
# an unpinned fetch would silently change which vintage the corpus results
# describe — which is the whole point of measuring this engine.
set -euo pipefail

VERSION="v1.4.0"
BASE="https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-${VERSION}"
DEST="public/engines/texlyre"
ARCHIVE="busytex-assets.tar.gz"

mkdir -p "$DEST"
cd "$DEST"

if [ -d busytex ]; then
  echo "texlyre ${VERSION} assets already in ${DEST}"
  exit 0
fi

# One 522 MB archive; there is no per-tier download, so a run that only needs
# `basic` still pays for `extra` once, here, rather than in the browser.
curl -fL --progress-bar -O "${BASE}/${ARCHIVE}"
tar -xzf "$ARCHIVE"
rm -f "$ARCHIVE"

cd - > /dev/null
echo "texlyre ${VERSION} assets ready in ${DEST}/busytex"
