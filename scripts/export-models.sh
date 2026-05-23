#!/usr/bin/env bash
# Export module GLBs from every .blend file in blender/.
# Requires `blender` on $PATH (or set $BLENDER to a full path).
# Any extra args are forwarded to blender/export_tiles.py for each file.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
blender_bin="${BLENDER:-blender}"

shopt -s nullglob
blend_files=("$root"/blender/*.blend)
if [ ${#blend_files[@]} -eq 0 ]; then
  echo "No .blend files found in $root/blender" >&2
  exit 1
fi

for blend in "${blend_files[@]}"; do
  echo "=== $(basename "$blend") ==="
  "$blender_bin" --background "$blend" --python "$root/blender/export_tiles.py" "$@"
done
