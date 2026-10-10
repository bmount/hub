// Names no organization may take. An organization's name is its web host (<org>.pimwell.com) and its inbox
// (<org>@pimwell.com), so a name that sounds official, belongs to infrastructure, or is a well-known mailbox could be
// used to impersonate, phish, or collide. The list is deliberately conservative: it is cheap to release a name
// later and impossible to take one back. Existing organizations are never affected by additions here.

const GROUPS: Record<string, string[]> = {
  // Hosts and services the hub uses or may use.
  infrastructure: [
    "www", "www1", "www2", "mail", "email", "mx", "smtp", "imap", "pop", "pop3", "ftp", "sftp", "ssh", "vpn", "ns", "ns1", "ns2",
    "dns", "api", "mcp", "git", "ardi", "cdn", "edge", "static", "assets", "img", "images", "media", "files", "file", "download",
    "downloads", "upload", "uploads", "app", "apps", "web", "proxy", "gateway", "internal", "local", "localhost", "status",
    "health", "metrics", "logs", "trace", "traces", "monitor", "monitoring", "dev", "development", "test", "testing", "staging",
    "stage", "prod", "production", "demo", "sandbox", "sbx", "playground", "preview", "beta", "alpha", "docs", "doc", "help",
    "blog", "news", "skills", "hub", "pimwell", "default", "null", "undefined", "void", "none", "example", "examples",
  ],
  // Sign-in, accounts, and anything a phishing message would want to sound like.
  accounts: [
    "login", "logout", "signin", "sign-in", "signup", "sign-up", "register", "auth", "oauth", "sso", "saml", "id", "identity",
    "account", "accounts", "password", "passwords", "reset", "verify", "verification", "confirm", "security", "secure", "trust",
    "safety", "fraud", "phishing", "spam", "abuse", "admin", "admins", "administrator", "root", "sysadmin", "system", "sys",
    "superuser", "owner", "owners", "moderator", "moderators", "staff", "official", "everyone", "all", "me", "you",
  ],
  // RFC 2142 role mailboxes and the hub's own addresses.
  mailboxes: [
    "postmaster", "hostmaster", "webmaster", "abuse", "noc", "privacy", "legal", "dmarc", "bounce", "bounces", "noreply",
    "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "mailerdaemon", "daemon", "nobody", "notify", "notifications",
    "alerts", "alert", "updates", "newsletter", "support", "info", "hello", "contact", "contactus", "feedback", "list", "lists",
    "announce", "inbox",
  ],
  // Offices and roles that carry authority inside any company.
  roles: [
    "ceo", "cfo", "coo", "cto", "cio", "cmo", "cso", "ciso", "cpo", "cro", "chro", "founder", "founders", "president",
    "chairman", "chair", "board", "directors", "executive", "executives", "exec", "investor", "investors", "ir", "hr", "people",
    "payroll", "billing", "invoice", "invoices", "payments", "payment", "finance", "accounting", "treasury", "sales",
    "marketing", "press", "pr", "careers", "jobs", "recruiting", "hiring", "office", "ops", "operations", "it", "helpdesk",
    "service", "services", "compliance", "gdpr", "dpo", "audit", "team", "teams",
  ],
  // Helpers and the words people use for them.
  helpers: ["agent", "agents", "bot", "bots", "helper", "helpers", "ai", "assistant", "assistants"],
  // Brands people trust and attackers imitate.
  brands: [
    "google", "gmail", "microsoft", "outlook", "apple", "icloud", "amazon", "aws", "meta", "facebook", "openai", "chatgpt",
    "anthropic", "claude", "cloudflare", "github", "gitlab", "stripe", "paypal", "slack", "zoom", "linkedin",
  ],
};

export const RESERVED_NAMES: ReadonlySet<string> = new Set(Object.values(GROUPS).flat());

/** Why a name is reserved, for an error message that helps rather than just refuses. */
export function reservedBecause(name: string): string | null {
  for (const [group, names] of Object.entries(GROUPS)) if (names.includes(name)) return group;
  return null;
}

/**
 * Names no agent may take inside an organization. Its address is <org>.<name>@pimwell.com: mailbox, account and
 * authority words are reserved to prevent impersonation within the organization. Agent words, brands and everyday
 * infrastructure words (claude, bot, dev, test) stay available because they are natural agent names.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn", "git", "ardi",
  ...GROUPS.accounts!, ...GROUPS.mailboxes!, ...GROUPS.roles!,
]);
