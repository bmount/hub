export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  OAUTH_KV: KVNamespace;
  MAIL: SendEmail;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
  HUB_INTERNAL_SECRET?: string;
  /** The Ardi git host (service binding); absent means git URLs answer 503. */
  ARDI?: Fetcher;
};
