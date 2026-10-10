# Recorded AI usage

`usage.summary` and MCP `usage_summary` return recorded model calls and costs for a period. Readers and members see their own calls. Only admins can request everyone's calls in the current organization. The AI usage page uses the same scope rule; selecting another person does not widen a member's scope.

## Work filter

Pass `work` to `usage.summary` / MCP `usage_summary`, or use the work-item filter on `/usage`, to restrict the period's totals and every breakdown to one work item. A reference such as `project#12` or the item's ID is resolved in the current tenant and returned as a canonical `work` reference. Unknown, foreign, channel or inconsistent work items are refused rather than silently showing an unfiltered report.

The filter never widens usage scope: members still see only their own calls, and API/MCP `everyone` remains admin-only. Filtered calls must match both the work ID and its project. The work inspector links to this filtered view; range chips and person links retain the work filter. Empty results mean no calls recorded in that period and scope, not that the work cost nothing.

## Work breakdown

`byWork` groups calls by their linked work item and returns the item's ID as `key`, its `project#number` reference as `label` and `ref`, call and token counts, known cost in millionths of a US dollar, and the number of unpriced calls. The page links valid references to the work inspector. MCP renders the same groups and coverage.

A work association must match the call's tenant and project, and the project must belong to that tenant and not be a channel. Missing or inconsistent associations share a **No matching work item** group with a null `ref`. They remain in the recorded totals; foreign or channel work references are not disclosed. The page's individual-call inspector applies the same association checks.

The breakdown shows at most 50 groups, including the unmatched group if it falls in that range. Groups sort by known cost descending, call count descending, then key. `byWorkCoverage` gives `limit`, `shown` and `truncated`; one extra group is read to distinguish a complete 50-group result from an incomplete one. Overall totals are calculated independently and include groups omitted from the breakdown.

These are recorded calls, not a complete cost-to-build estimate. Costs are fixed when a call is recorded. A null cost is unknown, not zero; a group with both priced and unpriced calls shows its known cost and an unpriced count. Unreported work, non-model costs and revenue are not inferred.
