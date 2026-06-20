#!/bin/bash
# Usage: bash tests/run_tests.sh
# Runs the smoke test suite headlessly and exits with the test result code.

GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/godot}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

"$GODOT" --headless --path "$PROJECT_DIR" "res://tests/SmokeTest.tscn" 2>&1 \
  | grep -v "^WARNING:" \
  | grep -v "^ERROR: [0-9]* RID"

exit ${PIPESTATUS[0]}
