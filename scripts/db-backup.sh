#!/bin/sh
# Daily, restorable database + media backup pairs for docker-compose.prod.yml.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MEDIA_DIR="${MEDIA_DIR:-/media}"

backup_once() {
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dump="$BACKUP_DIR/$PGDATABASE-$ts.dump"
  media="$BACKUP_DIR/media-$ts.tar.gz"
  ready="$BACKUP_DIR/pair-$ts.ready"

  # Neither final name appears until both components are complete. Publishing
  # media first means a concurrent off-site snapshot can at worst contain an
  # unused archive, never a database dump whose referenced photographs are
  # absent.
  if ! pg_dump --format=custom --no-owner --file="$dump.tmp"; then
    rm -f "$dump.tmp" "$media.tmp"
    echo "pg_dump failed for $PGDATABASE" >&2
    return 1
  fi
  if ! tar -czf "$media.tmp" -C "$MEDIA_DIR" .; then
    rm -f "$dump.tmp" "$media.tmp"
    echo "media backup failed for $MEDIA_DIR" >&2
    return 1
  fi

  mv "$media.tmp" "$media"
  mv "$dump.tmp" "$dump"
  : > "$ready.tmp"
  mv "$ready.tmp" "$ready"
  echo "backup pair written: $dump and $media"

  # Rotate only after a complete pair succeeds, so a failing backup job never
  # drains the last known-good restore points.
  find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" \
    -mtime +"$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name 'media-*.tar.gz' \
    -mtime +"$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name 'pair-*.ready' \
    -mtime +"$KEEP_DAYS" -delete
}

mkdir -p "$BACKUP_DIR"
test -d "$MEDIA_DIR"
find "$BACKUP_DIR" -maxdepth 1 \
  \( -name '*.dump.tmp' -o -name '*.tar.gz.tmp' -o -name '*.ready.tmp' \) \
  -delete

if [ "${1:-}" = "once" ]; then
  backup_once
  exit 0
fi

# Restart-safe schedule: the first pair lands at boot, then one just after each
# UTC midnight. A failed attempt leaves no final dump and is retried in 5m.
while :; do
  today="$(date -u +%Y%m%d)"
  if ! ls "$BACKUP_DIR/pair-$today"-*.ready >/dev/null 2>&1; then
    backup_once || true
  fi
  sleep 300
done
