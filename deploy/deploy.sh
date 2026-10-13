#!/usr/bin/env bash
# Publishes the site code (HTML, JS, CSS, vendor libraries) to the web root.
# The population data (tiles/, data/countries.json) is NOT copied: the server builds
# it itself with deploy/update-data.sh, and existing data there is left untouched.
#
#   On the server, after a git pull:   ./deploy/deploy.sh /var/www/popmap
#   From another machine:              ./deploy/deploy.sh user@server [/var/www/popmap]
#
# Files in the web root are owned by POPMAP_WEB_OWNER (default www-data:www-data).
# Locally that needs root (or running as that user); remotely the ssh user needs
# passwordless sudo for rsync, or connect as root@server.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f /etc/default/popmap ] && . /etc/default/popmap
OWNER="${POPMAP_WEB_OWNER:-www-data:www-data}"
TARGET="${1:?usage: deploy.sh /local/web/root  |  deploy.sh user@server [/var/www/popmap]}"
EXCLUDES=(--exclude '/tiles' --exclude '/tiles-*' --exclude '/tiles.new' --exclude '/data/countries.json*')

if [[ "$TARGET" == /* ]]; then
  if [ "$(id -u)" -eq 0 ]; then
    install -d -o "${OWNER%%:*}" -g "${OWNER#*:}" "$TARGET" "$TARGET/data"
    rsync -a --delete --chown="$OWNER" --chmod=D755,F644 "${EXCLUDES[@]}" "$HERE/web/" "$TARGET/"
  else
    [ "$(id -un):$(id -gn)" = "$OWNER" ] || echo "warning: not root, files will be owned by $(id -un) instead of $OWNER" >&2
    mkdir -p "$TARGET/data"
    rsync -a --delete --chmod=D755,F644 "${EXCLUDES[@]}" "$HERE/web/" "$TARGET/"
  fi
  echo "Done: site code is in $TARGET"
else
  REMOTE_DIR="${2:-/var/www/popmap}"
  ssh "$TARGET" "sudo install -d -o '${OWNER%%:*}' -g '${OWNER#*:}' '$REMOTE_DIR' '$REMOTE_DIR/data'"
  rsync -az --delete --rsync-path="sudo rsync" --chown="$OWNER" --chmod=D755,F644 "${EXCLUDES[@]}" "$HERE/web/" "$TARGET:$REMOTE_DIR/"
  echo "Done: site code is in $TARGET:$REMOTE_DIR"
fi
