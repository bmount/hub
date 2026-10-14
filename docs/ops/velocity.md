# Velocity

`/<project>/velocity` is the Docket's timing and attributed-usage view. It uses the workbench table and inspector, with a daily throughput chart and quest, kind, day and week tables. `velocity_read {project, quest?, since?}` and `/api/velocity.read` return the same data. Project-scoped MCP endpoints enforce the same project boundary as Docket.

## Cutoff and timing

`project.velocity_since` is a nullable UTC millisecond timestamp. Null means project creation. MCC's Pimwell cutoff is 2026-10-10 05:26 UTC; AgentFeed's is 2026-10-09 06:51 UTC. Only items filed at or after the effective cutoff are eligible. `since` accepts an ISO date or a relative period such as `7d`, narrowing the filing cohort but never moving before the configured cutoff. The view names its effective start.

Lead time is filed to closed; cycle time is first recorded claim to closed. Unclosed lead/cycle times and cycle/worked times without a recorded claim are null, not zero. Worked time is the union of recorded doing intervals: a claim starts work, release or an audited transition out of doing stops it, and closure/as-of bounds the final interval. Lease expiry does not change doing state and is not treated as a work-state event. Every claim, including renewals, counts toward attempts. Renewals never overlap worked time. Claimants are the workers; current ownership alone is not evidence of work.

Totals cover eligible items. Duration distributions cover done items, omitting unknown times and including the known count. Median and p90 use linear interpolation. Quest rollups cover all eligible descendants once, excluding the quest itself; a quest filter selects its descendants. Day/week throughput counts done closures. Work intervals are split at UTC midnight; tokens use the call's recorded timestamp. Weeks begin Monday. Thus daily work and token totals reconcile with the item totals instead of moving all work to the closure day.

Commits must be linked to an eligible item, present in the linked source project's recorded Git events, and timestamped at or after the cleanup cutoff. Old tracker references cannot bring excluded items or their commits into the result. Git records may lag upstream.

## Attributed usage

`usage_report` accepts `item: "project#n"` on an individual call or each entry in `calls`. It is an alias for `work`; supplying conflicting aliases is refused. Existing item resolution enforces tenant and project boundaries. Input includes cached input; cached tokens are a subset, not additional input. Costs are the ledger's recorded USD amounts, with null for no priced calls and an explicit unpriced-call count per item. Unknown tokens are not invented. Unattributed usage is excluded, not spread across items.

`scripts/backfill-loop-usage.mjs` reads the loop's `results.jsonl` and `usage.jsonl` without modifying either. With organization/identity-scoped D1 ledger and eligible-item JSON exports, it emits guarded updates only. A reported run must have an eligible current item and exactly one matching reported loop ledger row with the same organization, time and all token counts. Missing, duplicate, ambiguous and already-differently-attributed matches are skipped. Already-correct attribution is a no-op. There are no usage inserts, so backfilling never adds calls or token counts. `--self-test` checks matching and rerun safety. Review the emitted SQL before applying it with the deployment credential helper.
