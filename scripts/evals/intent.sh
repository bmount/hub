#!/bin/sh
# Run the "What do you want to do?" evals on production (docs/ops/evals.md).
#   scripts/evals/intent.sh <agent-address> <project-slug> [purpose] [case-ids,comma,separated]
# Every model call is attributed to that agent and project. The key comes from the Keychain item pimwell-eval-key and
# goes only into the request header, never argv or output.
set -e
WHO=${1:?agent address to attribute the usage to}
PROJECT=${2:?project slug in that agent's organization}
PURPOSE=${3:-fast}
ONLY=${4:-}
HUB=${PIMWELL_HUB:-pimwell.com}
OUT=$(mktemp)
BODY=$(python3 -c "import json,sys; print(json.dumps({'attribute_to': sys.argv[1], 'project': sys.argv[2], 'purpose': sys.argv[3], 'only': [x for x in sys.argv[4].split(',') if x]}))" "$WHO" "$PROJECT" "$PURPOSE" "$ONLY")
security find-generic-password -a pimwell -s pimwell-eval-key -w | sed 's/^/header = "authorization: Bearer /; s/$/"/' \
  | curl -sf -K - -X POST -H 'content-type: application/json' --data "$BODY" "https://$HUB/internal/evals/intent" > "$OUT"
python3 - "$OUT" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"{r['purpose']}: {r['passed']} passed, {r['failed']} failed")
for x in r["results"]:
    if not x["ok"]:
        print(f"  FAIL {x['id']}: \"{x['say']}\"\n       got:  {x['got']}\n       want: {x['want']}")
sys.exit(1 if r["failed"] else 0)
EOF
