# Recorded evidence on commits

`repo.commit` / MCP `repo_commit` and the commit inspector return `relatedWork` and `relatedWorkCoverage` (`limit`, `shown`, `truncated`). Reading a commit still goes through the git host as the caller. These associations do not prove that the commit completes, reviews or approves the work.

An explicit `commit` link matches `project@<full-40-character-hex-ID>`. The project prefix must match exactly; hex letter case is ignored. Short IDs no longer appear as exact commit associations in the inspector. Push sync records full commit IDs, so its links remain supported.

A `url` source matching `https://<tenant>.<hub-domain>/<project>/code?c=<lowercase-full-ID>` is **filed**; an explicit URL link is **linked**. Only the exact canonical URL matches. Extra branch parameters, fragments and alternate URLs are not inferred to identify a commit. Repository slugs contain only lowercase letters, digits and hyphens.

Each item appears once, preferring a URL source over a URL link over a commit link. The view shows up to 50 items, newest filing first with item ID descending as a tie-breaker. A 51st row detects truncation. Invalid rows are excluded before the limit. Archived project history and closed work remain readable. Inspector keys change when recorded associations, titles, states or deploy/error evidence change.

The source must be a repository in the current tenant. Work and its non-channel project must also belong to that tenant, with a positive integer work number of at most eight digits. Deploys and errors in the existing **After this commit** view require matching record/project tenants and a repository project. That view still uses recorded tag-prefix/time associations, not independent proof of live rollout or causation. Work destinations enforce their own access checks; a link grants no access or authority.
