#!/usr/bin/env bash
# Weekly: prove the off-site copy restores. Restores the newest snapshot from the restic repository (not from the
# local dumps) into a scratch database, prints counts, then prunes and checks the repository. Fails when the newest
# snapshot is older than $MAX_AGE_MIN minutes (default 120: the hourly backups stopped).
# Pings $RESTORE_PING_URL (healthchecks.io; /fail on any failure). Usage: offsite-check.sh
set -euo pipefail
# the restored dump is a full copy of the data: only the owner reads it
umask 077

if [ $# -ne 0 ]; then
  echo "usage: $0" >&2
  exit 1
fi

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi
export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
MAX_AGE_MIN=${MAX_AGE_MIN:-120}

# one backup at a time (the hourly one, a deploy's, this prune)
exec 9>.backup.lock
flock -w 900 9

tmp=$(mktemp -d)
cleanup() {
  local rc=$?
  rm -rf "$tmp"
  if [ "$rc" -ne 0 ] && [ -n "${RESTORE_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "$RESTORE_PING_URL/fail" >/dev/null || true
  fi
}
trap cleanup EXIT

# the image runs as root otherwise, and what it restores couldn't be deleted by this user
restic() {
  docker run --rm --user "$(id -u):$(id -g)" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY -v "$tmp:/restore" restic/restic:0.17.3 --no-cache "$@"
}

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "RESTIC_REPOSITORY is not set: nothing to check" >&2
  exit 1
fi

# seconds since the newest snapshot; empty repository -> fails
age=$(restic snapshots --host bookedup --tag db --latest 1 --json | python3 -c '
import json, re, sys, time
from datetime import datetime, timezone
snaps = json.load(sys.stdin)
if not snaps:
    sys.exit("no snapshots in the repository")
t = max(s["time"] for s in snaps)
t = re.sub(r"\.\d+", "", t).replace("Z", "+00:00")
print(int(time.time() - datetime.fromisoformat(t).timestamp()))
')
if [ "$age" -gt $((MAX_AGE_MIN * 60)) ]; then
  echo "newest snapshot is $((age / 60)) min old (limit $MAX_AGE_MIN): too old, backups stopped?" >&2
  exit 1
fi

restic restore latest --host bookedup --tag db --target /restore
dump=$(find "$tmp" -name 'bookedup-*.dump' | head -n 1)
if [ -z "$dump" ]; then
  echo "the snapshot holds no dump" >&2
  exit 1
fi
./restore-check.sh "$dump"

restic prune
restic check

if [ -n "${RESTORE_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$RESTORE_PING_URL" >/dev/null
fi
