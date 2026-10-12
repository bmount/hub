# Pushing to main never deploys. Releasing is its own step, for whoever holds the deploy token:
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_TOKEN_FILE, or the macOS Keychain (see scripts/cf/with-deploy-token.sh).
.PHONY: test release rollback

test:
	npm run typecheck
	npm test

# Test the current main, then upload, deploy and smoke-check pimwell-hub, pimwell-git and pimwell-tail together; record rollback versions.
release:
	scripts/cf/with-deploy-token.sh node scripts/release.mjs

# Put a previous version back: make rollback VERSION=<version id from the release record> [WORKER=pimwell-git]
rollback:
	@test -n "$(VERSION)" || { echo "usage: make rollback VERSION=<version id>" >&2; exit 2; }
	scripts/cf/with-deploy-token.sh npx wrangler versions deploy --name $(or $(WORKER),pimwell-hub) $(VERSION)@100% --yes
