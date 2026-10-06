export type Env = {
  HUB_DB: D1Database;
  RATE: KVNamespace;
  MAIL: SendEmail;
  HUB_DOMAIN: string;
  HUB_BOOTSTRAP_TOKEN: string;
};
