#!/bin/bash
# Usage: bash tests/run_tests.sh
# Runs the headless test scenes and exits non-zero if any of them fail.

GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/godot}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

run_scene() {
  "$GODOT" --headless --path "$PROJECT_DIR" "$1" 2>&1 \
    | grep -v "^WARNING:" \
    | grep -v "^ERROR: [0-9]* RID"
  return "${PIPESTATUS[0]}"
}

run_scene "res://tests/SmokeTest.tscn"
smoke_rc=$?
run_scene "res://tests/ShellTest.tscn"
shell_rc=$?

if [[ $smoke_rc -ne 0 || $shell_rc -ne 0 ]]; then
  exit 1
fi
exit 0
