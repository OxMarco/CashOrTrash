#!/bin/sh
# pg_dump + media sidecar loop (see the db-backup service in
# docker-compose.prod.yml). One custom-format dump and one matching media
# archive per UTC day into $BACKUP_DIR, rotated after $BACKUP_KEEP_DAYS days.
# Connection comes from the standard PG* env vars.
#
# `sh db-backup.sh once` takes a single pair and exits (used by `make db-backup`).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MEDIA_DIR="${MEDIA_DIR:-/media}"

do_dump() {
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dump="$BACKUP_DIR/$PGDATABASE-$ts.dump"
  media="$BACKUP_DIR/media-$ts.tar.gz"

  # Both components are written to .tmp names and moved into place so a run
  # interrupted mid-write can never be mistaken for a restorable backup (by
  # rotation, the healthcheck, or a human picking a file to restore). The dump
  # is published last, so the presence of a dump implies its media archive is
  # already complete — a restored database never names photographs that were
  # not captured with it.
  if ! pg_dump --format=custom --no-owner --file="$dump.tmp"; then
    rm -f "$dump.tmp"
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
  echo "backup written: $dump ($(du -h "$dump" | cut -f1)) and $media ($(du -h "$media" | cut -f1))"

  # Rotate only after a successful pair: if backups start failing, old ones
  # stop aging out instead of draining to zero.
  find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" -mtime +"$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name 'media-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
}

mkdir -p "$BACKUP_DIR"
test -d "$MEDIA_DIR"
find "$BACKUP_DIR" -maxdepth 1 \( -name '*.dump.tmp' -o -name '*.tar.gz.tmp' \) -delete

if [ "${1:-}" = "once" ]; then
  do_dump
  exit 0
fi

# Restart-safe daily schedule without cron or date math: back up whenever no
# dump stamped with today's UTC date exists yet. The first pair lands right
# after boot, later ones just after midnight UTC. A failed attempt is retried
# on the next tick because today's file still doesn't exist.
while :; do
  today="$(date -u +%Y%m%d)"
  if ! ls "$BACKUP_DIR/$PGDATABASE-$today"-*.dump >/dev/null 2>&1; then
    do_dump || true
  fi
  sleep 300
done
