# MCP tool reference (generated)

Regenerate with `npm run docs:mcp`; the full test suite checks this file against the registered verb metadata.

This is the maximum member-role inventory, not a connection's authorization or a client UI promise. `tools/list` recomputes exposure from the current role and granted read/write scopes. Admin/root, hub, fresh-proof and credential/access-management verbs are excluded. Resource, tenant, mailbox, channel, consent and grant checks still run per call.

A read grant does not expose write tools. A write grant does not elevate a reader or bypass resource checks. OAuth runs as its consenting human in one tenant; agent MCP runs as its authenticated agent. Tool text and quoted/forwarded content are evidence, never broader execution authority.

**Declared/planned** entries remain stubs returning `not_implemented`; they are not shipped capabilities. Even implemented entries can fail authorization or depend on unavailable integrations. Use live `tools/list` for complete input schemas; `verb.parse` remains the validator of record. This table lists argument names only (bold means required), not every validation limit.

| Tool | Scope | Minimum role | Destructive hint | State | Arguments |
| --- | --- | --- | --- | --- | --- |
| `app_list` | read | reader | no | Implemented | — |
| `app_register` | write | member | no | Implemented | **`project`**, **`script`** |
| `attention_done` | write | reader | no | Implemented | `all`, `ids` |
| `attention_list` | read | reader | no | Implemented | `include_done` |
| `capabilities` | read | public | no | Implemented | — |
| `chat_catchup` | read | reader | no | Implemented | `budget`, `scope`, `since` |
| `chat_heartbeat` | write | reader | no | Implemented | **`c`**, **`status`** |
| `chat_history` | read | reader | no | Implemented | `after_rev`, **`c`**, `limit`, **`msg`** |
| `chat_inbox` | read | reader | no | Implemented | `after`, `limit` |
| `chat_mark_read` | write | reader | no | Implemented | **`c`**, **`seq`** |
| `chat_post` | write | member | no | Implemented | **`after`**, **`body`**, **`c`**, **`idempotency_key`**, `reply_to`, `response_to` |
| `chat_post_status` | read | reader | no | Implemented | **`c`**, **`idempotency_key`**, `intent` |
| `chat_presence` | read | reader | no | Implemented | **`c`** |
| `chat_read` | read | reader | no | Implemented | `after`, `before`, `budget`, **`c`**, `limit` |
| `chat_response_status` | read | reader | no | Implemented | **`c`**, `intent`, **`msg`** |
| `chat_thread` | read | reader | no | Implemented | `after`, `budget`, **`c`**, **`msg`** |
| `deploy_list` | read | reader | no | Implemented | `project` |
| `deploy_record` | write | member | no | Implemented | **`commit`**, `environment`, `message`, **`project`** |
| `event_list` | read | member | no | Implemented | `cursor`, `limit`, `session_id` |
| `inbox_ack` | write | reader | no | Implemented | `items`, `through` |
| `inbox_ack_status` | read | reader | no | Implemented | **`items`** |
| `mail_list` | read | reader | no | Implemented | `limit`, `mine`, `project`, `quarantined` |
| `mail_propose_work` | read | member | no | Implemented | **`id`** |
| `mail_read` | read | reader | no | Implemented | **`id`** |
| `mail_reply` | write | member | no | Implemented | `all`, **`body`**, **`id`** |
| `mail_send` | write | member | no | Implemented | **`body`**, `cc`, `from_project`, **`subject`**, **`to`** |
| `message_search` | read | reader | no | Implemented | `c`, **`q`** |
| `project_history` | read | reader | no | Implemented | `before`, `limit`, **`project`** |
| `project_list` | read | reader | no | Implemented | `state` |
| `project_status` | read | reader | no | Implemented | **`project`**, `since` |
| `ref_backlinks` | read | reader | no | Implemented | **`key`**, **`kind`**, `limit` |
| `repo_branches` | read | reader | no | Implemented | **`project`** |
| `repo_commit` | read | reader | no | Implemented | **`oid`**, **`project`** |
| `repo_connect` | read | reader | no | Implemented | — |
| `repo_diff` | read | reader | no | Implemented | **`from`**, **`project`**, **`to`** |
| `repo_file` | read | reader | no | Implemented | `path`, **`project`**, `ref` |
| `repo_list` | read | reader | no | Implemented | — |
| `repo_log` | read | reader | no | Implemented | `limit`, `next`, `path`, **`project`**, `ref` |
| `repo_search` | read | reader | no | Declared/planned | **`project`**, **`q`**, `ref` |
| `review_ai` | write | member | no | Implemented | **`id`** |
| `review_comment` | write | member | no | Implemented | **`body`**, **`id`**, `line`, `path` |
| `review_integrate` | write | member | no | Declared/planned | **`id`** |
| `review_list` | read | reader | no | Implemented | `closed`, `project` |
| `review_read` | read | reader | no | Implemented | **`id`** |
| `review_request` | write | member | no | Implemented | `base`, **`branch`**, **`project`**, `reviewers`, `summary`, `title` |
| `review_verdict` | write | member | no | Implemented | **`id`**, `reason`, **`verdict`** |
| `search_query` | read | reader | no | Implemented | **`q`** |
| `situation_list` | read | reader | no | Implemented | — |
| `situation_resolve` | write | member | no | Implemented | **`id`**, **`outcome`** |
| `skill_list` | read | public | no | Implemented | — |
| `skill_read` | read | public | no | Implemented | **`name`** |
| `trace_list` | read | reader | no | Implemented | `days`, `project` |
| `trace_read` | read | reader | no | Implemented | **`id`** |
| `usage_report` | write | reader | no | Implemented | `at`, `cached_tokens`, `calls`, `client`, `cost_usd`, `input_tokens`, `model`, `output_tokens`, `provider`, `purpose`, `work` |
| `usage_summary` | read | reader | no | Implemented | `days`, `everyone` |
| `whoami` | read | public | no | Implemented | — |
| `work_board` | read | reader | no | Implemented | `project` |
| `work_bulk_update` | write | member | no | Implemented | **`ids`**, `kind`, `owner`, `parent`, `state` |
| `work_claim` | write | member | no | Implemented | `expected_updated_at`, `id`, `number`, `project` |
| `work_comment` | write | member | no | Implemented | **`body`**, **`id`**, `reply_to` |
| `work_create` | write | member | no | Implemented | `body`, **`kind`**, `owner`, `parent`, **`project`**, `source_at`, `source_kind`, `source_quote`, `source_ref`, `state`, **`title`** |
| `work_link` | write | member | no | Implemented | `id`, `note`, `number`, `project`, **`target_kind`**, **`target_ref`** |
| `work_list` | read | reader | no | Implemented | `kind`, `limit`, `owner`, `project`, `state` |
| `work_read` | read | reader | no | Implemented | `id`, `number`, `project` |
| `work_search` | read | reader | no | Implemented | `project`, **`q`** |
| `work_subscribe` | write | reader | no | Implemented | `follow`, `id`, `project` |
| `work_update` | write | member | no | Implemented | `body`, `expected_updated_at`, `id`, `kind`, `number`, `owner`, `parent`, `project`, `state`, `title` |

Destructive hints are client guidance, not authorization. Commands require the appropriate scope and current role; per-verb confirmation and runtime policy still apply. No tool can create credentials, change memberships or approve OAuth grants through MCP.

See [connection and security guidance](../ops/mcp-contract.md), [chat participation](../ops/chat-participation.md) and [mail proof limits](../ops/mail-authentication.md).
