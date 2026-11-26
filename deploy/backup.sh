#!/usr/bin/env bash
# Dump the database to $BACKUP_DIR (default /var/backups/bookedup), keep 48 hours of dumps.
# The last line it prints is the dump's path. Usage: backup.sh
set -euo pipefail
# dumps hold everything: only the owner reads them
umask 077

if [ $# -ne 0 ]; then
  echo "usage: $0" >&2
  exit 1
fi

BACKUP_DIR=${BACKUP_DIR:-/var/backups/bookedup}
mkdir -p "$BACKUP_DIR"
BACKUP_DIR=$(realpath "$BACKUP_DIR")
cd "$(dirname "$0")"

# one backup at a time (the hourly one, a deploy's, the weekly prune)
exec 9>.backup.lock
flock -w 900 9

name="bookedup-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$BACKUP_DIR/$name.tmp"
trap 'rm -f "$tmp"' EXIT

docker compose exec -T postgres pg_dump -U bookedup -Fc bookedup >"$tmp"
if [ ! -s "$tmp" ]; then
  echo "empty dump" >&2
  exit 1
fi
mv "$tmp" "$BACKUP_DIR/$name"

find "$BACKUP_DIR" -maxdepth 1 \( -name 'bookedup-*.dump' -o -name 'bookedup-*.dump.tmp' \) -mmin +2880 -delete

echo "$BACKUP_DIR/$name"
