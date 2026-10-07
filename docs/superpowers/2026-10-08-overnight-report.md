# Overnight report, round 2 (2026-10-08)

Plan: docs/superpowers/plans/2026-10-08-overnight-2.md. Detail and rulings: docs/superpowers/2026-10-07-overnight-ledger.md.
Everything below is on main, deployed to pimwell.com, and covered by the suite (648 tests, all passing).

## What you can try
- **Playground** (`/playground` on your organization): call any MCP tool as yourself, read-only or read and write, with
  no OAuth dance. Every call is audited.
- **Edit work in place**: open any item (for example mcc's `/pimwell/w/62`) and use Edit. You can change the title,
  kind, owner, quest and details.
- **The Docket's filters**: Mine, by owner, by quest, by kind, open or finished. The filters combine, and an empty list
  says which filter emptied it.
- **Mail to work**: `mail_propose_work` turns a forwarded thread into proposed wishes, snags and calls, each quoting the
  mail exactly.
- **Assistants can write**: the consent page now offers write, so a connected assistant can file and update work.

## Faster
- Signing in costs one database round trip instead of four, on every signed-in page. No page takes more than 4, and
  a test holds that line. Every response's Server-Timing header shows round trips, statements and time.
- An assistant's first hop to /mcp fell from 347 ms to 37 ms.
- `node scripts/perf-smoke.mjs mcc` times production. Public pages run 25 to 35 ms at the median.

## The Pimwell project
Round 2 is on mcc/pimwell's Docket:
- Done: #50, #51, #52, #59 and #63.
- Under way: #53 and #62.
- Filed: #73 to #77, including tonight's two calls with your words quoted.

## Needs you
1. **Helper addresses (N7, second half).** Projects and helpers now share one name space. Moving helpers to
   `<org>.<name>@pimwell.com` also needs a ruling, because today every address under an org subdomain is reserved for
   helpers. Proposal:
   - No human identity, invite or sign-in link may use any `@pimwell.com` address.
   - A helper never signs in by mail.
   - Then migrate the existing helpers' addresses (one migration, reversible).

   Say yes and I'll build it.
2. **Sandbox organizations (N6).** Letting any member create `sbx-…` organizations changes who may create an
   organization (root only today). Yes or no?
3. **Still waiting from before:**
   - Click delete on the archived agentfeed and pricebench organizations in /admin/orgs.
   - Accept the root invite.
   - The one-push re-import waits on Ardi's repo delete (requested in docs/requests/2026-10-07-ardi.md).

## Not touched
Ardi, by your ruling. Nothing there changed tonight.
