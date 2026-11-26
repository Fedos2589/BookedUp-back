#!/usr/bin/env bash
# Prove a dump restores: load it into a scratch database, print some counts, drop the database.
# Usage: restore-check.sh <dump>. Exit 2: no such dump; any other non-zero: the restore failed.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <dump>" >&2
  exit 1
fi
if [ ! -f "$1" ]; then
  echo "no such dump: $1" >&2
  exit 2
fi
dump=$(realpath "$1")
cd "$(dirname "$0")"

pg() { docker compose exec -T postgres "$@"; }

trap 'pg dropdb -U bookedup --if-exists restore_check >/dev/null' EXIT

pg dropdb -U bookedup --if-exists restore_check
pg createdb -U bookedup restore_check
pg pg_restore -U bookedup --no-owner --exit-on-error -d restore_check <"$dump"

pg psql -U bookedup -d restore_check -v ON_ERROR_STOP=1 -tA -F ' ' <<'SQL'
SELECT 'businesses', count(*) FROM businesses;
SELECT 'users', count(*) FROM users;
SELECT 'appointments', count(*) FROM appointments;
SELECT 'last migration', migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST, migration_name DESC LIMIT 1;
SQL
