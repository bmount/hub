#!/bin/sh
# Run a command (usually wrangler) as Cloudflare token pimwell-001 (developer + deploy),
# never as the machine-wide personal wrangler login.
#   scripts/cf/with-deploy-token.sh npx wrangler deploy
# CI and agents that already have CLOUDFLARE_API_TOKEN set keep it; otherwise it comes from
# the macOS Keychain item pimwell-cloudflare-dev.
set -e
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  CLOUDFLARE_API_TOKEN=$(security find-generic-password -a pimwell -s pimwell-cloudflare-dev -w 2>/dev/null) || {
    echo "No CLOUDFLARE_API_TOKEN and no pimwell-cloudflare-dev Keychain item. See docs/ops/cloudflare.md." >&2; exit 1; }
fi
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=f48d61ea6cf57096b3f7bcb02fa0c3e5
exec "$@"
