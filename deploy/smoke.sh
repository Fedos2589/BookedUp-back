#!/usr/bin/env bash
# Smoke test of a running deployment: smoke.sh <domain> [-k]. Prints ok/FAIL per line, exits 1 if any failed.
# -k: the certificate isn't trusted (local Caddy) and the http->https redirect isn't checked.
set -uo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ] || { [ $# -eq 2 ] && [ "$2" != -k ]; }; then
  echo "usage: $0 <domain> [-k]" >&2
  exit 1
fi
domain=$1
insecure=${2:-}
case "$domain" in
  *[!A-Za-z0-9.:-]*)
    echo "unexpected characters in the domain" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0

# request <url> [curl args...]: sets $code, $headers (lowercase), $body
request() {
  local url=$1
  shift
  code=$(curl -s -m 15 ${insecure:+-k} -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' "$@" "$url") || code=000
  headers=$(tr '[:upper:]' '[:lower:]' <"$tmp/headers" 2>/dev/null | tr -d '\r')
  body=$(cat "$tmp/body" 2>/dev/null)
}

report() { # <ok: 0|1> <name> <detail>
  if [ "$1" -eq 0 ]; then
    echo "ok    $2"
  else
    echo "FAIL  $2 ($3)"
    failed=1
  fi
}

has() { grep -qiE "$1" <<<"$2"; }

base="https://$domain"

request "$base/api/health"
{ [ "$code" = 200 ] && has '"status" *: *"ok"' "$body"; }
report $? "GET /api/health is 200 {status: ok}" "got $code"

request "$base/api/docs-json"
{ [ "$code" = 200 ] && has '"openapi"' "$body"; }
report $? "GET /api/docs-json is 200 with openapi" "got $code"

for path in / /book/smoke-test; do
  request "$base$path"
  { [ "$code" = 200 ] && has '^cache-control:.*no-cache' "$headers" && has '^content-type: *text/html' "$headers"; }
  report $? "GET $path is 200 text/html with Cache-Control no-cache" "got $code"
done
request "$base/sw.js"
{ [ "$code" = 200 ] && has '^cache-control:.*no-cache' "$headers"; }
report $? "GET /sw.js is 200 with Cache-Control no-cache" "got $code"

request "$base/assets/does-not-exist.js"
[ "$code" = 404 ]
report $? "GET /assets/does-not-exist.js is 404" "got $code"

request "$base/api/telegram/webhook" -X POST -H 'Content-Type: application/json' -d '{}'
[ "$code" = 401 ]
report $? "POST /api/telegram/webhook without the secret is 401" "got $code"

if [ -z "$insecure" ]; then
  request "http://$domain/"
  { [ "$code" = 308 ] && has "^location: *https://$domain/" "$headers"; }
  report $? "http://$domain/ redirects 308 to https" "got $code"
fi

exit "$failed"
