#!/usr/bin/env bash
#
# Bundles the app source into the Helm chart so it can be deployed without
# building or pushing a container image.
#
#   npm run package
#
# The chart mounts the resulting archive from a ConfigMap; an initContainer
# unpacks it and runs `npm install` for the three runtime dependencies. Re-run
# this after any change under src/, then commit the archive so Argo CD sees it.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="helm/provider-cluster-cleanup/files/src.tgz"
mkdir -p "$(dirname "$OUT")"

# Keep macOS resource forks out of the archive.
export COPYFILE_DISABLE=1

tar czf "$OUT" src package.json package-lock.json

SIZE=$(wc -c < "$OUT" | tr -d ' ')
LIMIT=$((900 * 1024))   # ConfigMaps cap out just above 1MB; leave headroom.

echo "packaged $OUT ($((SIZE / 1024))KB)"

if [ "$SIZE" -gt "$LIMIT" ]; then
  echo "ERROR: archive is too large for a ConfigMap (${SIZE} bytes > ${LIMIT})." >&2
  echo "Use the image-based mode instead: bundledSource.enabled=false" >&2
  exit 1
fi
