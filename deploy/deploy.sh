#!/usr/bin/env bash
# Deploy (or roll back) from the laptop: deploy.sh <ssh-target> [api-sha|-] [web-sha|-]
# An omitted sha or "-" keeps the image the server runs now. DRY_RUN=1 prints the rsync and the remote script.
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -lt 1 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <ssh-target> [api-sha|-] [web-sha|-]" >&2
  exit 1
fi
target=$1
api_sha=${2:--}
web_sha=${3:--}
case "$target$api_sha$web_sha" in
  *[!A-Za-z0-9@._:-]*)
    echo "unexpected characters in the arguments" >&2
    exit 1
    ;;
esac

files=()
for f in compose.yml Caddyfile .env.example api.env.example backup.sh restore-check.sh offsite-check.sh; do
  [ -e "$f" ] && files+=("$f")
done

remote_script() {
  # Everything is one function called with stdin closed: bash reads a script from the pipe line by line, and
  # `docker compose exec/run` would otherwise swallow the rest of it and the deploy would stop with exit 0.
  cat <<'REMOTE'
main() {
set -Eeuo pipefail
umask 077
cd /opt/bookedup
api_sha=$1
web_sha=$2
dump=none

previous() { tail -n 1 releases.log; }
failed() {
  echo "DEPLOY FAILED. .env still names the release that ran before (compose.yml and Caddyfile are already the new ones)." >&2
  if [ -s releases.log ]; then
    echo "roll back with: deploy/deploy.sh <target> $(previous | cut -d' ' -f2-)   (last releases.log line: $(previous))" >&2
  fi
  echo "Migrations are not rolled back: if the old code can't read the new schema, restore the dump taken by this deploy: $dump" >&2
}

if [ ! -f .env ] || [ ! -f api.env ]; then
  echo "create /opt/bookedup/.env and api.env from the examples first" >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a
. ./.env
set +a

current_sha() { # <image variable value> -> the tag, empty if unset
  [ -n "${1:-}" ] && echo "${1##*:}" || true
}
[ "$api_sha" = - ] && api_sha=$(current_sha "${API_IMAGE:-}")
[ "$web_sha" = - ] && web_sha=$(current_sha "${WEB_IMAGE:-}")
if [ -z "$api_sha" ] || [ -z "$web_sha" ]; then
  echo "first deploy: name both shas (api and web)" >&2
  exit 1
fi
new_api=ghcr.io/fedos2589/bookedup-api:$api_sha
new_web=ghcr.io/fedos2589/bookedup-web:$web_sha
echo "api: $new_api"
echo "web: $new_web"

for image in "$new_api" "$new_web"; do
  docker manifest inspect "$image" >/dev/null 2>&1 || {
    echo "no image for ${image##*:}: run Release on that commit first" >&2
    exit 1
  }
done

trap failed ERR
if [ -n "$(docker compose ps -q --status running postgres 2>/dev/null)" ]; then
  dump=$(./backup.sh </dev/null | tail -n 1)
  echo "restore point: $dump"
fi

# the shell's variables win over .env: .env is rewritten only after the health check
export API_IMAGE=$new_api WEB_IMAGE=$new_web
docker compose pull
docker compose up -d postgres redis
docker compose run --rm api npx prisma migrate deploy
docker compose up -d --remove-orphans --wait --wait-timeout 90

# the first deploy waits longer: Caddy is still getting its certificate
tries=45
[ -f releases.log ] || tries=150
healthy=false
for _ in $(seq 1 "$tries"); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
$healthy || {
  echo "no healthy answer from https://$DOMAIN/api/health in $((tries * 2)) s" >&2
  false
}

grep -v -e '^API_IMAGE=' -e '^WEB_IMAGE=' .env >.env.new || true
printf 'API_IMAGE=%s\nWEB_IMAGE=%s\n' "$new_api" "$new_web" >>.env.new
chmod 600 .env.new
mv .env.new .env
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $api_sha $web_sha" >>releases.log
trap - ERR
docker image prune -f >/dev/null || true
echo "deployed: $api_sha $web_sha"
}
main "$@" </dev/null
REMOTE
}

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "+ rsync ${files[*]} $target:/opt/bookedup/"
  echo "+ ssh $target bash -s -- $api_sha $web_sha <<'REMOTE'"
  remote_script
  echo "REMOTE"
  exit 0
fi

rsync -az "${files[@]}" "$target:/opt/bookedup/"
remote_script | ssh "$target" bash -s -- "$api_sha" "$web_sha"
