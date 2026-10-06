#!/usr/bin/env bash
# Point login@ and signup@ at the pimwell-hub Worker via Email Routing. Idempotent.
# Needs CLOUDFLARE_API_TOKEN with Email Routing Rules Write on the zone (spec 9).
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
DOMAIN="${HUB_DOMAIN:-pimwell.com}"
WORKER="${WORKER_NAME:-pimwell-hub}"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

zone=$(curl -fsS "${AUTH[@]}" "$API/zones?name=$DOMAIN" | jq -r '.result[0].id // empty')
[ -n "$zone" ] || { echo "zone $DOMAIN is not visible to this token" >&2; exit 1; }

enabled=$(curl -fsS "${AUTH[@]}" "$API/zones/$zone/email/routing" | jq -r '.result.enabled // false')
if [ "$enabled" != "true" ]; then
  echo "Email Routing is not enabled on $DOMAIN. Enable it in the dashboard (Email > Email Routing), then rerun." >&2
  exit 2
fi

rules=$(curl -fsS "${AUTH[@]}" "$API/zones/$zone/email/routing/rules?per_page=50")
for box in login signup; do
  addr="$box@$DOMAIN"
  if echo "$rules" | jq -e --arg a "$addr" '.result[] | select(any((.matchers // [])[]; .field == "to" and .value == $a))' >/dev/null; then
    echo "rule for $addr already exists"
    continue
  fi
  body=$(jq -n --arg a "$addr" --arg w "$WORKER" \
    '{name: ($a + " to " + $w), enabled: true, matchers: [{type: "literal", field: "to", value: $a}], actions: [{type: "worker", value: [$w]}]}')
  curl -fsS -X POST "${AUTH[@]}" -H 'content-type: application/json' "$API/zones/$zone/email/routing/rules" -d "$body" \
    | jq -r '"created rule " + .result.id + " for " + (.result.matchers[0].value)'
done
