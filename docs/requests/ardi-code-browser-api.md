# Pimwell-native code browsing: proposed Ardi API contract

## Ownership and immediate bug

Pimwell owns the user experience: project navigation, branch/tag selection, a source tree, syntax-highlighted line views, commit/compare pages, side-by-side or unified diffs, review annotations and merge controls. Ardi supplies authenticated Git data and safe repository operations. Ardi's own minimal HTML UI is not a constraint or a dependency.

The reported revision-format error is reproducible in Pimwell: it emits bare slash-containing branch names (`pio/topic`) but its revision normalizer only qualified names without slashes. #142 fixes normalization and tests clicking the actual generated branch/commit links. Existing `refs.list`, `log`, `commit.show`, `tree.list` and `file.show` are sufficient for basic browsing; no new Ardi API is required for that fix.

This document is a **proposal**, not a claim these extensions are implemented. It is intended as a concrete handoff to the Ardi implementer. Existing routes/verbs should remain backward compatible.

## Common transport, authority and truthfulness

Continue the authenticated JSON verb surface:

```text
POST /t/{tenant}/api/{verb}
Authorization: Basic <existing caller credential>
Content-Type: application/json
```

Pimwell proxies calls as the current viewer using the existing credential/introspection boundary. Never put credentials in URLs, leak Basic headers, mint an administrator to compensate for missing APIs, or expose public download links for private source.

Responses retain the existing envelope `{ok, result, next}`. Proposed errors additionally have a stable code: `invalid_revision`, `not_found`, `ambiguous_revision`, `forbidden`, `conflict`, `limit_exceeded`, `unavailable`. Do not use missing rows or empty diffs as substitutes for permission/backend errors. Reauthorize every paginated request and merge application.

All pages bind to an immutable resolved commit/tree/blob ID. Cursors are opaque, bounded and bound to tenant/repository/query/snapshot; they do not confer access. Return explicit truncation, continuation and coverage. Counts must be exact or clearly labeled unknown/approximate—never totals inferred from a capped example list.

Do not impose only ASCII branch names or confuse path separators with revision syntax. Validate Git refs/repository paths, not shell command strings. Reject arbitrary rev expressions or executable commands. Case-sensitive paths, Unicode and slash-containing branch names must round-trip. Existing SHA-1 IDs remain supported; responses can advertise object format for future SHA-256 rather than silently accepting incompatible IDs.

## 1. `rev.resolve` — unambiguous names and immutable links

Input:

```json
{"repo":"pimwell","revision":{"kind":"branch","name":"pio/topic"}}
```

Kinds: `head`, `branch`, `tag`, `commit`. A commit uses `oid` rather than `name`. Optional unique abbreviated IDs may be supported explicitly; collisions return `ambiguous_revision`, never an arbitrary match.

Output:

```json
{"oid":"<full commit id>","tree_oid":"<tree id>","object_format":"sha1","ref":"refs/heads/pio/topic","kind":"branch"}
```

Peel annotated tags safely and identify non-commit objects explicitly. A branch and tag with the same short name stay distinguishable. Pimwell can render concise names while linking to exact commits, without relying on Ardi's web routes.

## 2. Extend `refs.list`, `log`, `tree.list`, `commit.show`

- `refs.list`: prefix/kind filtering and stable pagination; distinguish branches/tags/forks instead of counting every non-head ref as a tag.
- `log`: immutable resolved start ID, opaque cursor, optional path and explicit traversal policy (`first_parent` or graph history). Describe merge semantics rather than implying complete history from a first-parent index.
- `tree.list`: accept resolved commit/tree, directory path, limit/cursor; return snapshot ID, entry name/kind/mode/object ID and byte size when known. Never inflate every blob to draw the directory.
- `commit.show`: return complete commit metadata/parents plus paginated changed-file metadata. Include previous path, change type, before/after mode and blob IDs where available. Exact changed-file count or explicit unavailable count. Do not silently lose files after a fixed display limit.

Pimwell controls pagination, source-language detection and rendering. Repository strings/content are untrusted data and must be escaped; private source is never executed in the browser.

## 3. `diff.compare` — branch reviews without a 20-commit ancestor limit

Input:

```json
{"repo":"pimwell","base":{"kind":"branch","name":"main"},"head":{"kind":"branch","name":"pio/topic"},"mode":"merge_base","limit":100,"cursor":null}
```

Modes:

- `direct`: difference between the two resolved snapshots.
- `merge_base`: pull-request-style difference from a common ancestor to head.

Output:

```json
{"base_oid":"<resolved base>","head_oid":"<resolved head>","comparison_base_oid":"<merge base or direct base>","mode":"merge_base","files":[{"path":"src/app.ts","previous_path":null,"kind":"modify","before_blob":"<id>","after_blob":"<id>","before_mode":"100644","after_mode":"100644","binary":false}],"total_files":1,"coverage":"complete","truncated":false}
```

Envelope `next` paginates files on the same immutable comparison. Support additions, deletions, renames where detected, mode-only changes, binaries, symlinks and submodules with explicit representation. Multiple merge bases or unrelated histories require a defined result/error, not a guessed ancestor. Expensive traversal gets a bounded budget and resumable/job result if needed, not silent incomplete success.

Current Pimwell comparison walks at most 20 commits and demands an ancestor; this native API is the concrete backend gap for larger/branched reviews.

## 4. `diff.file` — bounded structured hunks

Input identifies the immutable comparison (`base_oid`, `head_oid`, mode/comparison base), file path, context-line count, limit and cursor. It must not accept an unauthenticated public comparison capability.

Output includes before/after blob IDs, binary/omission reason, totals if known, and hunks with old/new ranges and structured lines (`context`, `add`, `remove`, old/new line numbers and text). Preserve no-final-newline information. Expose explicit continuation and reasons for byte/line/time limits. Pagination stays stable even when branch tips move.

Pimwell can render unified/side-by-side views and clickable line comments from the same data. Comments bind to head/blob/comparison and side/line, not an unstable branch name. After edits, mark annotations stale or remap with explicit evidence; never silently attach old approval/comments to new code.

## 5. `file.lines` and authenticated raw access

A bounded source-line operation accepts repository, immutable commit, path, start line, limit/cursor; returns blob ID, encoding/binary indication, line numbers/text, total lines when known and continuation. Avoid loading an arbitrarily large blob or building an unbounded line index per request.

Raw downloads use existing authenticated bytes/blob access or an authenticated Pimwell proxy, not public presigned URLs. For HTML/SVG/JS and other executable repository content, use safe plain-text/download behavior, nosniff and appropriate disposition. Validate symlink/submodule handling instead of traversing host filesystem paths.

## 6. Optional subsequent APIs

- `file.blame`: immutable revision/path/range to original commit/author/line attribution, paginated and bounded; describe merge/rename behavior.
- `code.search`: repository/ref snapshots plus query/path/language filters; return bounded line hits with coverage/index freshness. Search must obey exactly the same access policy as file reads.
- `capabilities`: machine-readable supported verbs, object formats, limits and index coverage. Pimwell can show honest unavailable states instead of promising unsupported features.

These are not blockers for the current basic browser; implement only when prioritized.

## 7. `merge.preview` / `merge.apply` — server-side review integration

This is separate from browsing and is the missing backend operation behind Pimwell's currently planned review Integrate button.

`merge.preview` takes repository, base/head refs and expected exact tips, strategy (`fast_forward`, `merge_commit`, or explicitly supported alternatives), and returns either a bounded conflict report or a short-lived immutable plan with resulting tree/commit inputs. Read permissions and write eligibility are explicit; preview is not permission to apply.

`merge.apply` takes plan ID, expected base/head IDs and a caller idempotency key. It rechecks current caller permissions, repository policy, expiry and tips, and **atomically compare-and-swaps** the target ref. Stale tips/conflicts return structured `conflict`; no partial write and no history overwrite. Preserve append-only policy, caller/session attribution and timeline audit. Exact retries return the prior result; reuse of a key with a different payload fails.

Pimwell binds approval/check results to the exact reviewed head and applicable base/policy. Ardi enforces repository write and append-only rules; it must not infer approval from untrusted model prose. Pre-alpha can permit ordinary authorized integration without a human review gate, but cannot waive data isolation or atomic ref safety.

## Acceptance and implementation order

1. Fix Pimwell #142 using existing APIs, including browser-generated links and malformed-input rejection.
2. Build richer Pimwell file/commit/review navigation and rendering on existing verbs—no Ardi UI dependency.
3. Ardi `rev.resolve` and native paginated comparison/file hunks for immutable review snapshots and larger diffs.
4. Optional line/raw/blame/search enhancements as needed, with explicit bounds/coverage.
5. Preview/apply merge contract for review integration, separately tested as consequential writes.

Contract tests must cover slash/Unicode refs, branch/tag ambiguity, moved branch tips between pages, >20 commits and >20 changed files, binary/mode/rename changes, huge files, revoked credentials, cross-tenant/repository access, unsafe raw content, stale merge plans and duplicate/reused idempotency keys. A successful HTTP response must not hide a truncated/error result.
