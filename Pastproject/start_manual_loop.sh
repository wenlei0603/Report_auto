#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export PYTHONPATH="$ROOT_DIR/.deps${PYTHONPATH:+:$PYTHONPATH}"
PYTHON_EXE="${PYTHON_EXE:-$ROOT_DIR/.venv/bin/python}"
BROWSER_PROFILE="${BROWSER_PROFILE:-$HOME/.lseg-rpa-browser-profile}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222/json/version}"
WORKSPACE_URL="${WORKSPACE_URL:-https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID}"
CONFIG_PATH="${CONFIG_PATH:-config/config.macos.yaml}"

pick_browser_app() {
  local candidates=(
    "/Applications/Microsoft Edge.app"
    "/Applications/Google Chrome.app"
  )
  local app_path
  for app_path in "${candidates[@]}"; do
    if [[ -d "$app_path" ]]; then
      printf '%s\n' "$app_path"
      return 0
    fi
  done
  return 1
}

wait_for_cdp() {
  local wait_seconds="${1:-20}"
  local i
  for ((i = 1; i <= wait_seconds; i++)); do
    if curl --silent --show-error --fail --max-time 1 "$CDP_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ ! -x "$PYTHON_EXE" ]]; then
  echo "[ERROR] Python venv not found: $PYTHON_EXE"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[ERROR] curl not found in PATH."
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  CONFIG_PATH="config/config.macos.example.yaml"
fi

if ! BROWSER_APP="${BROWSER_APP:-$(pick_browser_app)}"; then
  echo "[ERROR] Neither Microsoft Edge.app nor Google Chrome.app was found in /Applications."
  exit 1
fi

echo "[INFO] Checking browser CDP on port 9222..."
if ! wait_for_cdp 2; then
  echo "[INFO] Starting browser with remote debugging port 9222..."
  open -na "$BROWSER_APP" --args --remote-debugging-port=9222 --user-data-dir="$BROWSER_PROFILE" "$WORKSPACE_URL"
  if ! wait_for_cdp 20; then
    echo "[ERROR] Browser CDP did not become ready on port 9222."
    exit 1
  fi
else
  echo "[INFO] Existing browser CDP detected."
fi

echo "[INFO] Starting manual loop driver..."
"$PYTHON_EXE" "scripts/manual_loop_driver.py" --config "$CONFIG_PATH" --day-page-limit 650
