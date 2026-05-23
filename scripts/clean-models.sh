#!/usr/bin/env bash
# Delete every .glb under src/modules/*/assets/. Run before ./export-models.sh
# to make sure stale models (renamed collections, removed kingdoms) don't
# linger on disk. Only .glb files are touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

find "$root/src/modules" -mindepth 3 -maxdepth 3 -type f -name '*.glb' -print -delete
