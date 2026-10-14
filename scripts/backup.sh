#!/usr/bin/env bash
# Copy InstaOp data to a timestamped folder. Set INSTAOP_DATA and INSTAOP_BACKUP.
set -euo pipefail
DATA="${INSTAOP_DATA:-./data}"
DEST_ROOT="${INSTAOP_BACKUP:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${DEST_ROOT}/${STAMP}"
mkdir -p "$DEST"
if [[ -d "$DATA" ]]; then
  cp -a "$DATA/." "$DEST/"
fi
echo "backup written to ${DEST}"
echo "This copies InstaOp files only, including drafts and originals. It does not delete Bitcoin data."
