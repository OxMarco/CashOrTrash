#!/bin/sh
# pg_dump sidecar loop (see the db-backup service in docker-compose.prod.yml).
# One custom-format dump per UTC day into $BACKUP_DIR, rotated after
# $BACKUP_KEEP_DAYS days. Connection comes from the standard PG* env vars.
#
# `sh db-backup.sh once` takes a single dump and exits (used by `make db-backup`).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MEDIA_DIR="${MEDIA_DIR:-/media}"
MEDIA_KEEP_WEEKS="${MEDIA_KEEP_WEEKS:-4}"

# Item photography, tarred weekly rather than daily: the store is
# content-addressed, so it only ever grows, and a daily copy of the same
# immutable bytes buys nothing. Kept here alongside the dumps because a
# database restored without its media leaves every item naming a file that no
# longer exists — and the originals live on somebody else's server.
do_media() {
  [ -d "$MEDIA_DIR" ] || return 0

  week="$(date -u +%GW%V)"
  out="$BACKUP_DIR/media-$week.tar.gz"
  [ -f "$out" ] && return 0

  if tar -czf "$out.tmp" -C "$MEDIA_DIR" .; then
    mv "$out.tmp" "$out"
    echo "media backup written: $out ($(du -h "$out" | cut -f1))"
    find "$BACKUP_DIR" -maxdepth 1 -name 'media-*.tar.gz' \
      -mtime +"$((MEDIA_KEEP_WEEKS * 7))" -delete
  else
    rm -f "$out.tmp"
    echo "media tar failed" >&2
    return 1
  fi
}

do_dump() {
  ts="$(date -u +%Y%m%d-%H%M%S)"
  out="$BACKUP_DIR/$PGDATABASE-$ts.dump"
  # Dump to a .tmp name and mv into place so a dump interrupted mid-write can
  # never be mistaken for a restorable backup (by rotation, the healthcheck,
  # or a human picking a file to restore).
  if pg_dump --format=custom --no-owner --file="$out.tmp"; then
    mv "$out.tmp" "$out"
    echo "backup written: $out ($(du -h "$out" | cut -f1))"
    # Rotate only after a successful dump: if dumps start failing, old backups
    # stop aging out instead of draining to zero.
    find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" -mtime +"$KEEP_DAYS" -delete
  else
    rm -f "$out.tmp"
    echo "pg_dump failed for $PGDATABASE" >&2
    return 1
  fi
}

mkdir -p "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 \( -name '*.dump.tmp' -o -name '*.tar.gz.tmp' \) -delete

if [ "${1:-}" = "once" ]; then
  do_dump
  do_media || true
  exit 0
fi

# Restart-safe daily schedule without cron or date math: dump whenever no dump
# stamped with today's UTC date exists yet. The first dump lands right after
# boot, later ones just after midnight UTC — which is when the daily challenge
# rolls over and the nightly rank snapshot runs, so each dump captures a
# settled day. A failed attempt is retried on the next tick because today's
# file still does not exist.
while :; do
  today="$(date -u +%Y%m%d)"
  if ! ls "$BACKUP_DIR/$PGDATABASE-$today"-*.dump >/dev/null 2>&1; then
    do_dump || true
  fi
  # Same stamped-file trick, one week wide. Never allowed to fail the loop: a
  # media tar that cannot be written must not stop the database dumps.
  do_media || true
  sleep 300
done
