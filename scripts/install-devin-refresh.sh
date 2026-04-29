#!/usr/bin/env bash
# Install a 15-minute cron job that auto-refreshes the devin-web bearer token
# in 8router's local lowdb (db.json). Linux-only.
#
# Usage:
#   bash scripts/install-devin-refresh.sh           # install
#   bash scripts/install-devin-refresh.sh --uninstall

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/devin-refresh.cjs"
LOG_DIR="${DATA_DIR:-$HOME/.9router}"
LOG_FILE="$LOG_DIR/devin-refresh.log"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH. Install Node.js >= 20 first." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "Refresh script missing: $SCRIPT" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

CRON_LINE="*/15 * * * * cd $ROOT && $NODE_BIN $SCRIPT >> $LOG_FILE 2>&1"
TAG="# 8router devin-web auto-refresh"

current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | grep -v -F "$TAG" | grep -v -F "scripts/devin-refresh.cjs" || true)"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -z "$filtered" ]]; then
    crontab -r 2>/dev/null || true
  else
    printf '%s\n' "$filtered" | crontab -
  fi
  echo "Removed devin-web auto-refresh cron entry."
  exit 0
fi

new="$(printf '%s\n%s\n%s\n' "$filtered" "$TAG" "$CRON_LINE")"
printf '%s\n' "$new" | crontab -

echo "Installed cron entry:"
echo "  $CRON_LINE"
echo ""
echo "Bootstrap the Devin login next (runs Chromium in GUI mode):"
echo "  node $SCRIPT --bootstrap"
echo ""
echo "Tail the log:"
echo "  tail -f $LOG_FILE"
