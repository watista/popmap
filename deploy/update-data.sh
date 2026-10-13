#!/usr/bin/env bash
# Cron wrapper for scripts/update_data.py: runs it with the project venv and appends
# the output to a log file. Settings can be overridden in /etc/default/popmap.
# When run as root (e.g. from root's crontab), everything in the web dir ends up owned
# by POPMAP_WEB_OWNER (default www-data:www-data).
#   ./deploy/update-data.sh            # normal run (no-op if the data is current)
#   ./deploy/update-data.sh --force    # extra arguments are passed on
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f /etc/default/popmap ] && . /etc/default/popmap

POPMAP_VENV="${POPMAP_VENV:-$REPO/.venv}"
export POPMAP_WEB_DIR="${POPMAP_WEB_DIR:-/var/www/popmap}"
export POPMAP_WORK_DIR="${POPMAP_WORK_DIR:-/var/lib/popmap}"
export POPMAP_WEB_OWNER="${POPMAP_WEB_OWNER-www-data:www-data}"
LOG="${POPMAP_LOG:-$POPMAP_WORK_DIR/update.log}"

mkdir -p "$POPMAP_WORK_DIR"
# keep the log from growing forever
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then mv "$LOG" "$LOG.1"; fi

# low priority, so the website stays responsive while tiles are being built
nice -n 10 ionice -c3 "$POPMAP_VENV/bin/python" "$REPO/scripts/update_data.py" "$@" 2>&1 | tee -a "$LOG"

# safety net: the updater already sets the owner on what it writes; this also fixes
# anything left root-owned by an earlier manual run (only touches mismatching files)
if [ "$(id -u)" -eq 0 ] && [ -n "$POPMAP_WEB_OWNER" ] && [ -d "$POPMAP_WEB_DIR" ]; then
  u="${POPMAP_WEB_OWNER%%:*}" g="${POPMAP_WEB_OWNER#*:}"
  find "$POPMAP_WEB_DIR" \( ! -user "$u" -o ! -group "$g" \) -exec chown -h "$u:$g" {} +
fi
