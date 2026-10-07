import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

export const HOST = "acme.pimwell.test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiBody = { ok: boolean; result?: any; error?: string; detail?: string | null; data?: any };

export async function call(token: string, verb: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: ApiBody }> {
  const res = await apiPost(HOST, verb, body, bearer(token));
  return { status: res.status, body: (await res.json()) as ApiBody };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ok(token: string, verb: string, body: Record<string, unknown> = {}): Promise<any> {
  const r = await call(token, verb, body);
  if (r.status !== 200) throw new Error(`${verb} answered ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.result;
}

/** Tenant acme: lead (admin) operates scout, dev (member) operates tidy. Tokens are browser and run sessions. */
export async function chatWorld() {
  const acme = await seedTenant("acme");
  const lead = await seedHuman("lead@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const dev = await seedHuman("dev@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const scout = await seedAgent(acme, lead.identity, "scout");
  const tidy = await seedAgent(acme, dev.identity, "tidy");
  return { acme, lead, dev, scout, tidy };
}
export type World = Awaited<ReturnType<typeof chatWorld>>;

/** A channel created by lead with the named agents added by their operators. */
export async function channelWith(w: World, slug = "general", agents: Array<"scout" | "tidy"> = ["scout", "tidy"]): Promise<void> {
  await ok(w.lead.token, "channel.create", { slug });
  for (const a of agents) await ok(a === "tidy" ? w.dev.token : w.lead.token, "channel.add_agent", { c: slug, agent: a });
}

/** Polls until `check` is true, so a test acts only once an asynchronous step (a parked long poll) has happened. */
export async function until(check: () => Promise<boolean> | boolean, what = "condition", ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
