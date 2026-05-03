#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_EXE="${PYTHON_EXE:-$ROOT_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON_EXE" ]]; then
  echo "[ERROR] Python venv not found: $PYTHON_EXE"
  exit 1
fi

echo "[INFO] This will archive current stable progress files and reset the manual loop state."
echo "[INFO] Use this only when you want to restart all tasks from the beginning."
read -r -p "Type RESET to continue: " CONFIRM
if [[ "${CONFIRM^^}" != "RESET" ]]; then
  echo "[INFO] Canceled."
  exit 0
fi

"$PYTHON_EXE" "scripts/init_manual_loop_state.py"
