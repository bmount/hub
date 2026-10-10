# Assistant conversations

The Assistant at `/assistant` runs in a person's browser session within one organization. It uses the same permission checks as MCP. Conversations are private to that identity and organization. Read-only is the default; write tools require the person's explicit scope choice.

Successful turns append to the transcript. The model receives the latest 30 stored messages plus the new question, not history supplied by the browser. The composer allows one pending turn at a time. A follow-up typed during that turn stays as an unsent draft until the answer arrives.

Chat, Conversations and Tools retain the current conversation. New chat starts a separate one. Opening the conversation list preserves the live composer and transcript; reloading restores the stored transcript. An error response that identifies a created conversation keeps its navigation, but failed turns may have no stored transcript. A dropped connection does not prove that tool effects failed; check the record before retrying a change.

## Connecting a hosted assistant

The Assistant's model instructions include the current organization's `/mcp` URL and browser OAuth flow for hosted ChatGPT or Claude. The person verifies their identity and organization and reviews read/write consent. This consent is separate from the built-in Assistant's conversation scope; neither bypasses role or resource permissions. Connector availability and labels depend on the client, plan and workspace policy; the guidance does not claim hosted-client acceptance has been tested.

Headless coding agents instead claim a one-time Connect an agent link and use their own token at `/agent/mcp`. Tokens and login proofs must not be pasted into chat. Human connections can be reviewed and revoked at the hub's `/me` page.

## Storage

D1 `assistant_thread` stores each conversation's identity, organization, title and scope. `assistant_message` stores completed user/assistant exchanges and tool summaries. `model_call` records observed provider calls and usage; tool calls are audited as `playground.call` events. These are distinct from channel chat, whose message bodies live in Conversation Durable Objects with a D1 `msg_index`.

The home-page intent box (`/do`) is a dispatcher, not a transcript. It can navigate, show results, propose an action or send a question to the Assistant. Missing Assistant rows alone do not establish that a person never used an intent box or an external chat client.
