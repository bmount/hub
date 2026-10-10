# Situation reports and outcomes

A situation investigation uses read-only tools. Its original question and diagnosis are stored together; later assistant conversation does not rewrite the saved diagnosis. The diagnosis contains free-text cause, evidence, estimate and confidence sections, not measured accuracy scores.

A tenant member can record one outcome. The first submission atomically stores the outcome, recorder identity and time. An exact retry by that recorder succeeds without changing the record; another outcome or recorder receives a conflict. Blank outcomes are rejected. Existing legacy outcomes or partial attribution are not overwritten or silently repaired.

The Situations page shows the original diagnosis alongside the recorded outcome, with recorder and time when available. Outcomes are member-reported claims, not independently verified facts. The tenant-scoped `situation_list` result also includes `outcome_by`, `outcome_at` and `outcome_who`. Readers can view reports but cannot record outcomes. Model/project aggregation, structured calibration and outcome corrections with revision history are not implemented.
