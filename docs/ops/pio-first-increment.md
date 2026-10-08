# Pio first increment: connection guidance and audit attachment evidence

Tracks pimwell#83 and pimwell#86.

## Connection guidance

`/connect-assistant` serves a public human guide; `/connect-assistant.json` provides the same grounded instructions to clients/models. On an organization host the exact endpoint is `https://<org>.<hub>/mcp`, using streamable HTTP and OAuth. Apex guidance asks users to choose an organization. Supported scopes come from OAUTH_SCOPES rather than promising nonexistent write rights. The guide explains browser identity/organization checking, whoami/capabilities verification, plan/workspace-dependent connector availability, and the distinction from headless agent credentials.

This branch does not retrofit the deployed AI chat prompt: the corresponding source is absent from the available Git main. The reconciled chat implementation should reference the guide rather than inventing integration instructions.

## Attachment evidence

For future received mail, text/plain and text/markdown attachment text is retained in existing attachment JSON: maximum 20,000 characters per attachment and 60,000 total. Binary, HTML and executable MIME types remain metadata-only. mail_read renders bounded attachment excerpts as untrusted evidence. Existing admitted/quarantine and membership gates are unchanged. This does not recover attachments already discarded, add arbitrary downloads, execute files, or change email sender authentication.

## Security / release gate

No receipt suppression in this increment: current main uses message.reply() for sender proof. pimwell#85 needs decoupled trusted authentication and a recipient/response-routing model before notifications can safely be suppressed.

Do not deploy this branch over the current live Worker until pimwell#87 is resolved. Live agent-mail/chat functionality and schema differ from origin/main. A successful local suite is not evidence that old source will preserve deployed features.

## Validation

- Baseline: typecheck passed; 602/606 tests passed, four 5-second timeouts.
- New focused tests: 13 passed.
- Updated complete suite: 611 tests across 78 files passed with CLI `--testTimeout=30000` (no committed timeout weakening).
- Reduced-worker attempt was terminated after 180 seconds; shared Durable Object errors appeared. The successful full run also logged Durable Object exceptions from tests; investigate harness behavior separately rather than calling all console errors harmless.
- npm audit reports five high-severity development-tree findings (pimwell#88); no force upgrade/downgrade applied.
