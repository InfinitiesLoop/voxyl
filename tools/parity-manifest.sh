#!/bin/bash
# Usage: bash tools/parity-manifest.sh <instance .minecraft dir> <vanilla client jar> <out dir> [--keep-sandbox]
# Runs tools/parity-manifest.gd headlessly with every write sandboxed under <out dir>/sandbox
# (libraries, projects, palettes, prefabs, settings), so the real Voxyl data is never touched.
# Writes <out dir>/nei-manifest.json and <out dir>/final-manifest.json. See the .gd header.

if [[ $# -lt 3 ]]; then
    echo "Usage: $0 <instance .minecraft dir> <vanilla client jar> <out dir> [--keep-sandbox]" >&2
    exit 2
fi
if [[ -n "${GODOT:-}" ]]; then
    :
elif [[ -f "/Applications/Godot.app/Contents/MacOS/Godot" ]]; then
    GODOT="/Applications/Godot.app/Contents/MacOS/Godot"
elif [[ -f "/c/godot.exe" ]]; then
    GODOT="/c/godot.exe"
else
    echo "ERROR: Godot executable not found. Set GODOT to its path." >&2
    exit 1
fi
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MC="$1"; JAR="$2"; OUT="$3"; shift 3
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -W 2>/dev/null || pwd)"   # absolute, drive-letter form on Windows
SANDBOX="$OUT/sandbox"

"$GODOT" --headless --path "$PROJECT_DIR" -s tools/parity-manifest.gd -- \
    "$MC" "$JAR" "$OUT" "--sandbox=$SANDBOX" "--library=$SANDBOX/library" "$@"
