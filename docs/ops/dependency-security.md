# Development dependency security

## Reviewed increment: #88 (2026-10-09)

`npm audit --json` on source `2d21cdb` reported five affected package names:
Sharp, Undici, their parent Miniflare, Wrangler, and the Workers Vitest pool.
These are development/test/deployment-tool chains, not an observed production
exploit. The parent findings are inherited, not three additional root flaws.
`npm audit --omit=dev` and the complete audit must both be checked on updates.
An empty audit means no **currently reported** known advisories, not universal safety.

### Root advisories reviewed

| Package / advisory | Reported behavior | Change |
| --- | --- | --- |
| Sharp [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) | libheif heap corruption; affected Sharp below 0.35.4 | Both 0.35.2 and nested 0.35.4 copies replaced with 0.35.5 |
| Sharp [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | librsvg use-after-free; affected below 0.35.5 | 0.35.5 with its matched native/WASM packages and libvips 1.3.4 |
| Undici [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) | WebSocket permessage-deflate unhandled-error DoS | Development 7.29.0 replaced with 7.29.1 |
| Undici [GHSA-pmjh-fq2x-6v4x](https://github.com/advisories/GHSA-pmjh-fq2x-6v4x) | Orphaned RetryHandler response-body DoS | Same patch |
| Undici [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) | Retry-interceptor response splitting | Same patch |
| Undici [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | Unrequested WebSocket subprotocol DoS | Same patch |
| Undici [GHSA-3xpg-4rpp-hhhm](https://github.com/advisories/GHSA-3xpg-4rpp-hhhm) | Unbounded response decompression DoS | Same patch |
| Undici [GHSA-2jfj-6hjv-fm6j](https://github.com/advisories/GHSA-2jfj-6hjv-fm6j) | Shared-cache Set-Cookie disclosure | Same patch |
| Undici [GHSA-2gqq-gqf2-x968](https://github.com/advisories/GHSA-2gqq-gqf2-x968) | Dump-interceptor oversized chunk response truncation | Same patch |
| Undici [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) | BalancedPool TLS validation options dropped | Same patch |
| Undici [GHSA-8436-99hf-9mmv](https://github.com/advisories/GHSA-8436-99hf-9mmv) | Caching/replay of unsafe-method responses | Same patch |
| Undici [GHSA-rx4f-c7p8-82vq](https://github.com/advisories/GHSA-rx4f-c7p8-82vq) | WebSocketStream unclean-close DoS | Same patch |

The reported Undici ranges all end before 7.29.1. Feature-specific local
reachability is not assumed: patching is preferable to dismissing findings on
that basis. The patch floors also match the dependencies of upstream
Miniflare `5.20261006.1-alpha` in registry metadata.

## Why scoped overrides

`package.json` overrides Sharp/Undici **under Miniflare only**. This covers both
the pinned Workers-test Miniflare `5.20260815.0-alpha` and Wrangler's nested
`5.20261006.0-alpha`. It avoids an unrelated Workers-test/runtime upgrade and
npm's suggested Vitest-pool downgrade to 0.16.16. Wrangler, Vitest pool,
Miniflare and Workerd versions remain unchanged. Production `mailauth`'s
Undici 8.11.2 is untouched; no global Undici downgrade is allowed.

The lockfile retains registry integrity hashes; Sharp's platform optional
packages are updated together. The large deletion in the lockfile is removal
of the duplicate nested Sharp/native/Undici tree, not missing platform support.
Node 24 meets Sharp/Undici engine requirements. Installation uses
`npm ci --ignore-scripts`, preserving the existing no-unreviewed-install-script
boundary. No schema, deployment binding, real user or credential change is needed.

## Repeatable verification

```sh
npm ci --ignore-scripts
npm ls sharp undici miniflare wrangler workerd
npm audit
npm audit --omit=dev
npm run typecheck
npm test
npm run test:browser:chat
npx wrangler deploy --dry-run --outdir /tmp/pimwell-dependency-build
```

`npm test` first runs `scripts/test-dev-dependencies.mjs` with Node's test runner,
then the full native-Workers Vitest suite. Host tests check every nested lockfile
copy, matched Sharp native/WASM/libvips versions and integrity, scoped overrides,
actual resolution from every installed Miniflare, and unchanged production
Undici. Negative fixtures catch vulnerable nested copies and absent integrity.
Offline smoke tests exercise real native Sharp SVG/PNG processing and Undici
request/response APIs with a network-disabled MockAgent. These are compatibility
and regression guards, **not exploit reproductions** or new cryptographic tests.
Exact reviewed-version guards must be deliberately revised on a later upgrade;
continue checking current upstream advisories rather than treating pins as safe
forever. Cross-platform lock coverage is checked, but native smoke only runs on
the host platform. The dry run bundles locally; it is not a live release.

Use the normal managed release flow after tests and ordinary main merge. Record
live rollout and rollback separately; do not infer deployment from a build.
