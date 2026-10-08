import type { Conversation } from "./chat/conversationDO";
import type { Inbox } from "./chat/inboxDO";
export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  OAUTH_KV: KVNamespace;
  MAIL: SendEmail;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
  HUB_INTERNAL_SECRET?: string;
  /** Sign in with Google (OAuth web client). Both unset means the Google button is hidden. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** AES-GCM key (32 bytes, base64) sealing provider keys at rest (admin spec 10.2). */
  HUB_SECRETS_KEY?: string;
  /** Bearer for POST /internal/evals/intent; unset, the route does not exist. */
  EVAL_KEY?: string;
  /** The Ardi git host (service binding); absent means git URLs answer 503. */
  ARDI?: Fetcher;
  /** One SQLite object per channel, named `<tenant_id>:<conversation_id>` (messaging spec 9.1). */
  CONVERSATION: DurableObjectNamespace<Conversation>;
  /** One SQLite object per member identity, named `<tenant_id>:<identity_id>` (messaging spec 9.2). */
  INBOX: DurableObjectNamespace<Inbox>;
};
