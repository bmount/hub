import type { Env } from "../env";

export type ArdiAsk = { kind: "commit" | "ticket"; repo: string; id: string };
export type ArdiAnswer = { found: true; key: string; title: string } | { found: false; ambiguous: boolean };

const OID = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 3000;

/**
 * Commit and ticket refs resolved by Ardi as the poster (plan decision: `POST /internal/resolve`). Null means Ardi
 * could not answer (no binding, no secret, an error, a timeout, or a reply outside the contract), never "not found".
 */
export async function ardiResolve(env: Env, q: { tenant: string; principal: string; session: string; refs: ArdiAsk[] }): Promise<ArdiAnswer[] | null> {
  if (q.refs.length === 0) return [];
  if (!env.ARDI || !env.HUB_INTERNAL_SECRET) return null;
  try {
    const res = await env.ARDI.fetch("https://ardi.internal/internal/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-internal": env.HUB_INTERNAL_SECRET },
      body: JSON.stringify(q),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; results?: unknown };
    if (body.ok !== true || !Array.isArray(body.results) || body.results.length !== q.refs.length) return null;
    return body.results.map((r, i) => answer(r, q.refs[i]!));
  } catch (e) {
    console.log("ardi resolve failed", e instanceof Error ? e.name : "error");
    return null;
  }
}

function answer(r: unknown, ask: ArdiAsk): ArdiAnswer {
  const x = (r !== null && typeof r === "object" ? r : {}) as { found?: unknown; key?: unknown; title?: unknown; ambiguous?: unknown };
  if (x.found !== true) return { found: false, ambiguous: x.ambiguous === true };
  const title = typeof x.title === "string" ? x.title.slice(0, 80) : "";
  if (ask.kind === "commit") {
    const oid = typeof x.key === "string" ? x.key.toLowerCase() : "";
    return OID.test(oid) && oid.startsWith(ask.id) ? { found: true, key: `${ask.repo}@${oid}`, title } : { found: false, ambiguous: false };
  }
  return { found: true, key: `${ask.repo}#${ask.id}`, title };
}
