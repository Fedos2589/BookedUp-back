#!/usr/bin/env bash
# Dump the database to $BACKUP_DIR (default /var/backups/bookedup), keep 48 hours of dumps, send the dump off-site
# with restic and ping $BACKUP_PING_URL (healthchecks.io; /fail on any failure).
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

# RESTIC_*, AWS_* and BACKUP_PING_URL come from .env (the environment wins if .env is absent, as in checks)
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi
export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# one backup at a time (the hourly one, a deploy's, the weekly prune)
exec 9>.backup.lock
flock -w 900 9

name="bookedup-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$BACKUP_DIR/$name.tmp"
# any failure below pings /fail; a failed ping must not hide the real exit code
cleanup() {
  local rc=$?
  rm -f "$tmp"
  if [ "$rc" -ne 0 ] && [ -n "${BACKUP_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "$BACKUP_PING_URL/fail" >/dev/null || true
  fi
}
trap cleanup EXIT

# the image runs as root otherwise, and what it restores couldn't be deleted by this user
restic() {
  docker run --rm --user "$(id -u):$(id -g)" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY -v "$BACKUP_DIR:/backups:ro" restic/restic:0.17.3 --no-cache "$@"
}

docker compose exec -T postgres pg_dump -U bookedup -Fc bookedup >"$tmp"
if [ ! -s "$tmp" ]; then
  echo "empty dump" >&2
  exit 1
fi
mv "$tmp" "$BACKUP_DIR/$name"

find "$BACKUP_DIR" -maxdepth 1 \( -name 'bookedup-*.dump' -o -name 'bookedup-*.dump.tmp' \) -mmin +2880 -delete

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  # no success ping: a server without off-site copies must alert
  echo "RESTIC_REPOSITORY is not set: NO off-site copy was made" >&2
else
  restic cat config >/dev/null 2>&1 || restic init
  restic backup --host bookedup --tag db "/backups/$name"
  # --group-by: every dump has its own file name, the default grouping by host,paths would never forget anything.
  # No --prune here: offsite-check.sh prunes weekly.
  restic forget --host bookedup --tag db --group-by host,tags --keep-hourly 48 --keep-daily 30 --keep-weekly 12 \
    --keep-monthly 11
  if [ -n "${BACKUP_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "$BACKUP_PING_URL" >/dev/null
  fi
fi

echo "$BACKUP_DIR/$name"
