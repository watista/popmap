#!/usr/bin/env bash
# Publishes the site code (HTML, JS, CSS, vendor libraries) to the web root.
# The population data (tiles/, data/countries.json) is NOT copied: the server builds
# it itself with deploy/update-data.sh, and existing data there is left untouched.
#
#   On the server, after a git pull:   ./deploy/deploy.sh /var/www/popmap
#   From your own machine (WSL):       ./deploy/deploy.sh user@server [/var/www/popmap]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: deploy.sh /local/web/root  |  deploy.sh user@server [/var/www/popmap]}"
EXCLUDES=(--exclude '/tiles' --exclude '/tiles-*' --exclude '/tiles.new' --exclude '/data/countries.json*')

if [[ "$TARGET" == /* ]]; then
  mkdir -p "$TARGET/data"
  rsync -a --delete "${EXCLUDES[@]}" "$HERE/web/" "$TARGET/"
  echo "Done: site code is in $TARGET"
else
  REMOTE_DIR="${2:-/var/www/popmap}"
  ssh "$TARGET" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$(whoami) '$REMOTE_DIR'"
  rsync -az --delete "${EXCLUDES[@]}" "$HERE/web/" "$TARGET:$REMOTE_DIR/"
  echo "Done: site code is in $TARGET:$REMOTE_DIR"
fi
