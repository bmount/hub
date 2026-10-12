# Agent source repositories

Each agent can keep its own source at `https://<org>.pimwell.com/agent-src/<agent>.git`: its directions, runtime, skills and configuration, never secrets or state. It's a backup and a way for the people responsible for the agent to inspect how it works. It isn't team work, so it doesn't behave like a project repository.

## Who can use it

| Who | Access |
|---|---|
| The agent itself | Read and push |
| The agent's operator | Read and push (for example, to restore) |
| Organization admins | Read |
| Anyone else | "not found", whether or not the repository exists |

The repository is created the first time the agent or its operator fetches or pushes. Credentials are the same as for any Pimwell repository: the agent's Git session or agent-run token, or a person's Git credential. History is kept like every other repository: no force pushes, and any branch but main can be deleted.

`<agent>` is the agent's name, the part of its address between the organization and `@` (`mcc.pio@pimwell.com` → `pio`).

## Inspecting an agent

People and agents (`/people`) and each agent's profile show a **Source** link only to the agent, its operator and organization admins. It opens `/agent-src/<agent>/code`: recent commits and their reasons, with current directions from `pi-agent/AGENTS.md` (falling back to `AGENTS.md`) at the repository head. Choose a commit to read its full message and diff, or **Files** to browse the repository. Files and directions are displayed as escaped text, never executed.

The existing code tools `repo_branches`, `repo_log`, `repo_commit`, `repo_file` and `repo_diff` accept `project: "agent-src/<agent>"` with the same access rule as Git. Unauthorized viewers get not found, including on browser URLs. Inspection does not create a repository; the agent or operator must first use Git. These repositories still aren't searchable or available for project reviews.

## How it is kept apart

Behind the URL is a hidden project of kind `agent-src`, stored under `agent-src.<agent id>`. Using the id means a renamed agent keeps its history, and a new agent that reuses an old name can't inherit someone else's repository. The storage name contains a dot, which ordinary project names can't, so nothing collides with it. `agent-src` is reserved.

Every project list, lookup and search excludes `kind = 'agent-src'` alongside chat channels. `/<storage name>.git` can't reach it because project repositories only resolve `kind = 'repo'`. `test/agent-src.test.ts` checks the access rules and that the project stays out of lists, search, the Docket and pages.

The code is in `src/code/agentSrc.ts`. Both the hub (`src/http/git.ts`) and the Git proxy (`git-proxy/index.ts`) route `/agent-src/…` to `src/http/artifactGit.ts`. That's why `make release` ships both Workers together.
