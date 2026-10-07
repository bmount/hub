#!/bin/sh
# Run a command (usually wrangler) as the pimwell-deploy token instead of the machine-wide login.
#   scripts/cf/with-deploy-token.sh npx wrangler deploy
set -e
T=$(security find-generic-password -a pimwell -s pimwell-cloudflare-deploy -w 2>/dev/null) || {
  echo "No pimwell-cloudflare-deploy token in the Keychain. See docs/ops/cloudflare.md." >&2; exit 1; }
CLOUDFLARE_API_TOKEN="$T" CLOUDFLARE_ACCOUNT_ID=f48d61ea6cf57096b3f7bcb02fa0c3e5 exec "$@"
