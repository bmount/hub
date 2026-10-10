# Recorded evidence on commits

`repo.commit` / MCP `repo_commit` and the commit inspector return `relatedWork` and `relatedWorkCoverage` (`limit`, `shown`, `truncated`). Reading a commit still goes through the git host as the caller. These associations do not prove that the commit completes, reviews or approves the work.

An explicit `commit` link matches `project@<full-40-character-hex-ID>`. The project prefix must match exactly; hex letter case is ignored. Short IDs no longer appear as exact commit associations in the inspector. Push sync records full commit IDs, so its links remain supported.

A `url` source matching `https://<tenant>.<hub-domain>/<project>/code?c=<lowercase-full-ID>` is **filed**; an explicit URL link is **linked**. Only the exact canonical URL matches. Extra branch parameters, fragments and alternate URLs are not inferred to identify a commit. Repository slugs contain only lowercase letters, digits and hyphens.

Each item appears once, preferring a URL source over a URL link over a commit link. The view shows up to 50 items, newest filing first with item ID descending as a tie-breaker. A 51st row detects truncation. Invalid rows are excluded before the limit. Archived project history and closed work remain readable. Inspector keys change when recorded associations, titles, states or deploy/error evidence change.

The source must be a repository in the current tenant. Work and its non-channel project must also belong to that tenant, with a positive integer work number of at most eight digits. Deploys and errors require matching record/project tenants and a repository project. Work destinations enforce their own access checks; a link grants no access or authority.

## Deploy and error samples

The **After this commit** view prefers a deploy whose recorded `version_id` is the exact full commit ID (hex letter case is ignored). If the version is not a full hex commit ID, a 7–40-character hex tag matching the commit prefix is a weaker hint. Malformed tags and SQL wildcard characters never match. A contradictory full version ID prevents falling back to its tag. Exact matches take precedence over hints; within each class the earliest recorded time wins, then deploy ID.

`after.shipped` keeps its historical field name for compatibility, but now includes `match: full-commit | tag-prefix`. It is labelled **Recorded deploy**, not proof that the code shipped or is still live. `after.since` samples project deploy records at or after commit time, not verified descendants of the commit.

`after.errorsSince` gives the error window's timestamp and basis (`full-commit`, `tag-prefix`, or `commit-time`). Error groups are included when their first recorded time is at or after the selected deploy reference; without one, the window starts at commit time. Timing does not establish causation, and no recorded errors does not establish their absence.

Deploy and error samples each show at most 10 records. `sinceCoverage` and `errorsCoverage` give the limit, shown count and truncation flag; an 11th valid row detects truncation. Filtering precedes the limit. Samples are ordered by recorded time ascending, then record ID, so ties are stable. Neither exact record matching nor these time windows independently verifies a live rollout.
