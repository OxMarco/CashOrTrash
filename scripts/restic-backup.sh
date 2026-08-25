#!/bin/sh
# Copy finalized local backup pairs to an encrypted off-host Restic repository.
set -eu

STATE_DIR="${RESTIC_STATE_DIR:-/state}"
MARKER="$STATE_DIR/last-success"

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

mkdir -p "$STATE_DIR"

# A missing repository is a valid first boot. Wrong credentials or an
# unreachable existing repository make init fail loudly and keep health red.
if ! restic cat config >/dev/null 2>&1; then
  restic init
fi

backup_once() {
  restic backup /backups --tag cashortrash-production
  restic forget \
    --tag cashortrash-production \
    --keep-daily "${RESTIC_KEEP_DAILY:-14}" \
    --keep-weekly "${RESTIC_KEEP_WEEKLY:-8}" \
    --keep-monthly "${RESTIC_KEEP_MONTHLY:-12}" \
    --prune
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER.tmp"
  mv "$MARKER.tmp" "$MARKER"
  echo "off-site backup completed: $(cat "$MARKER")"
}

if [ "${1:-}" = "once" ]; then
  backup_once
  exit 0
fi

# Back up whenever a new pair-ready marker is newer than the last snapshot.
# Watching the marker (published after both files) prevents a race where Restic
# sees the media archive just before the matching database dump is finalized.
while :; do
  if [ ! -f "$MARKER" ] || find /backups -maxdepth 1 -name 'pair-*.ready' -newer "$MARKER" | grep -q .; then
    backup_once || true
  fi
  sleep 300
done
