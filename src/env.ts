export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  OAUTH_KV: KVNamespace;
  MAIL: SendEmail;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
  HUB_INTERNAL_SECRET?: string;
};
