import type { DNSResolver } from "mailauth";
import { readBoundedMail } from "./raw";

const MAX_QUERIES = 6;
const MAX_CNAME_HOPS = 4;

// DNS names, not URLs. Service/selector labels may contain underscores. Names
// are never used as an HTTP authority, including after trusted DNS indirection.
function dnsName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid key name");
  const name = value.replace(/\.$/, "").toLowerCase();
  if (name.length > 253 || !name.includes(".") || !name.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label))) {
    throw new Error("invalid key name");
  }
  return name;
}

// RFC 1035 character-string presentation from the trusted JSON resolver. Decode
// quoted segments and \DDD / escaped printable characters; never eval/unescape
// JSON twice. Non-printable/non-ASCII key bytes and malformed escapes fail closed.
function txtSegments(data: unknown): string[] {
  if (typeof data !== "string" || data.length > 8192) throw new Error("invalid key TXT");
  const segments: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i++] !== '"') throw new Error("invalid key TXT");
    let segment = "";
    let closed = false;
    while (i < data.length) {
      let c = data[i++]!;
      if (c === '"') { closed = true; break; }
      if (c === "\\") {
        c = data[i++] ?? "";
        if (/^[0-9]$/.test(c)) {
          const digits = c + data.slice(i, i + 2);
          if (!/^\d{3}$/.test(digits)) throw new Error("invalid key TXT escape");
          i += 2;
          c = String.fromCharCode(Number(digits));
        }
      }
      if (!c || c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126) throw new Error("invalid key TXT byte");
      segment += c;
      if (segment.length > 255) throw new Error("key TXT segment limit");
    }
    if (!closed || segments.length >= 32) throw new Error("invalid key TXT");
    segments.push(segment);
    if (i === data.length) break;
    if (data[i] !== " " && data[i] !== "\t") throw new Error("invalid key TXT separator");
    while (data[i] === " " || data[i] === "\t") i++;
    if (i === data.length) throw new Error("invalid key TXT separator");
  }
  if (!segments.length) throw new Error("key absent");
  return segments;
}

type KeyAnswer = { alias?: string; records: string[][] };

/** Fixed HTTPS authority; shared per-message request/time budgets. Only a validated
 * connected CNAME chain can delegate a TXT key lookup. No native DNS, arbitrary
 * URLs, redirects, additional-section trust or authentication-header fallback.
 * Trust is this HTTPS resolver, not a claim of DNSSEC validation.
 */
export function createDkimResolver(fetcher: typeof fetch = fetch): DNSResolver {
  let queries = 0;
  const deadline = Date.now() + 5000;
  return async (name, type) => {
    let current = dnsName(name);
    if (type !== "TXT" || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\._domainkey\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(current)) {
      throw new Error("key query refused");
    }
    const visited = new Set<string>([current]);
    let hops = 0;
    for (;;) {
      const remaining = deadline - Date.now();
      if (++queries > MAX_QUERIES || remaining <= 0) throw new Error("key lookup budget");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(2000, remaining));
      let answers: Map<string, KeyAnswer>;
      try {
        const url = new URL("https://cloudflare-dns.com/dns-query");
        url.searchParams.set("name", current); url.searchParams.set("type", "TXT");
        const response = await fetcher(url, { headers: { accept: "application/dns-json" },
          signal: controller.signal, redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/dns-json")) throw new Error("key lookup refused");
        const bytes = await readBoundedMail(response.body!, 16 * 1024);
        if (controller.signal.aborted || Date.now() >= deadline) throw new Error("key lookup budget");
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (data.Status !== 0 || (data.TC !== undefined && data.TC !== false)
          || !Array.isArray(data.Question) || data.Question.length !== 1
          || data.Question[0]?.type !== 16 || dnsName(data.Question[0]?.name) !== current
          || !Array.isArray(data.Answer) || !data.Answer.length || data.Answer.length > 16) throw new Error("key lookup unavailable");
        answers = new Map();
        for (const answer of data.Answer) {
          const owner = dnsName(answer?.name);
          const entry = answers.get(owner) ?? { records: [] };
          if (answer.type === 5) {
            if (entry.alias || entry.records.length) throw new Error("conflicting key alias");
            entry.alias = dnsName(answer.data);
          } else if (answer.type === 16) {
            if (entry.alias) throw new Error("conflicting key alias");
            entry.records.push(txtSegments(answer.data));
          } else throw new Error("unsupported key answer");
          answers.set(owner, entry);
        }
      } finally { clearTimeout(timer); }
      // Recursive resolvers may bundle the whole chain (in any answer order) or
      // return only CNAMEs. Every answer must belong to this one connected chain.
      for (;;) {
        const entry = answers.get(current);
        if (!entry) {
          if (answers.size) throw new Error("unrelated key answer");
          break; // follow the validated target with another bounded TXT query
        }
        answers.delete(current);
        if (entry.alias) {
          if (++hops > MAX_CNAME_HOPS || visited.has(entry.alias)) throw new Error("key alias cycle or limit");
          visited.add(entry.alias);
          current = entry.alias;
        } else {
          // The pinned verifier reads the first TXT RR. Refuse multiple records
          // explicitly rather than authorizing whichever key happened to arrive first.
          if (answers.size || entry.records.length !== 1) throw new Error("ambiguous key answer");
          return entry.records;
        }
      }
    }
  };
}
