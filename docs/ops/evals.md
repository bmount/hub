# Evals

## "What do you want to do?" (intent)

Everything Pimwell does should be reachable by saying it. The cases in `src/intent/evals.ts` are things people say,
with the actions that count as right. They run against the real model through the same code as the box.

**Run:**
```sh
scripts/evals/intent.sh <agent-address> <project-slug> [purpose] [case-ids]
```
- **Attribution:** every model call is recorded on the AI usage ledger against that agent and project, with client
  `intent-eval`. Development usage always belongs to a process, never to nobody.
- **Purpose:** `fast` by default, the model the box uses. `reasoning` or `deep` compare larger models; run those
  sparingly.
- **Key:** the Keychain item `pimwell-eval-key`, which is also the Worker secret `EVAL_KEY`. Without that secret
  the route doesn't exist.
- **Limits:** at most 60 cases per run and 10 runs an hour.

**Box JSON endpoint:** `GET https://<org>.pimwell.com/do?q=<words>&format=json` accepts the viewer's
browser cookie or bearer session. It returns the checked `intent` and the resolved `go` link or confirmation
`card`; it never follows links, opens chats or sends messages. Names resolve within the viewer's organization.
Agent source resolution uses the same self/operator/admin access rule as the repository; inaccessible agents'
source requests return the ordinary 404. Research/knowledge-base views open the wiki, uploaded files open
`documents`, and graph views open contacts, where selecting a contact shows its neighborhood.

**When a case fails:** decide whether the answer was actually wrong.
- If the person would have been well served, widen the case's expected outcomes, and say why in `why`.
- If not, fix the catalog or its rules in `src/intent/catalog.ts`.
- Add a case for every phrasing that goes wrong in use. The list starts modest and is meant to grow.

**History:**
- 2026-10-08, first runs: 29 of 31.
  - Spoken email addresses were left out.
  - "Issues" was read as bugs only.
- Fixed both in the rules, and added cases for spoken references and "tickets".
- Then 33 of 33 on `fast` twice, and on `reasoning` once.
