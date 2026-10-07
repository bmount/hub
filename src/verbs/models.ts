// Models and keys administration (admin spec 10). Hub scope, root only, in phase P1. Organization-scoped keys and
// MCP exposure arrive with phase P2's scopes and secret links; a secret is never returned by any verb here.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { recordEvent } from "../db/events";
import { addCredential, listCredentials, promoteCredential, purposeStatus, retireCredential, reverifyCredential, setRoute } from "../models/store";
import { ask, type Answer } from "../models/ask";
import { esc } from "../html";
import { PROVIDERS } from "../models/providers";

const audit = (ctx: Parameters<Parameters<typeof defineVerb>[0]["run"]>[0], kind: string, id: string, summary: string) =>
  recordEvent(ctx.db, { tenant_id: null, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind, target_kind: "provider_credential", target_id: id, summary }, ctx.now);

export const providerStatus = defineVerb({
  name: "provider.status", kind: "query", scope: "hub", minRole: "root", freshProofMinutes: null,
  summary: "Models and keys: what each purpose needs, which model and key serve it, recent calls and errors, and every key.",
  parse: () => ({}),
  run: async (ctx) => ({
    purposes: await purposeStatus(ctx.db, null, ctx.now),
    keys: await listCredentials(ctx.db, null),
    providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, key_hint: p.keyHint })),
    secrets_key_configured: Boolean(ctx.env.HUB_SECRETS_KEY),
  }),
});

export const providerKeyAdd = defineVerb({
  name: "provider.key_add", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, humanOnly: true,
  summary: "Add a provider key. It is checked with the provider first; it becomes active if there is none, otherwise standby.",
  parse: (i) => ({ provider: reqString(i, "provider", { max: 40 }), label: optString(i, "label", { max: 80 }) ?? "", key: reqString(i, "key", { max: 400 }) }),
  run: async (ctx, p) => {
    const c = await addCredential(ctx.db, ctx.env.HUB_SECRETS_KEY, { provider: p.provider, label: p.label, secret: p.key, tenant_id: null, created_by: ctx.identity!.id }, ctx.now);
    await audit(ctx, "provider.key_add", c.id, `Added ${c.provider} key ${c.fingerprint} (${c.status})`);
    return { key: c };
  },
});

export const providerKeyPromote = defineVerb({
  name: "provider.key_promote", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, humanOnly: true,
  summary: "Make a standby key active. The previous active key becomes standby, so rolling back is the same action.",
  parse: (i) => ({ key_id: reqString(i, "key_id", { max: 40 }) }),
  run: async (ctx, p) => {
    const r = await promoteCredential(ctx.db, p.key_id);
    await audit(ctx, "provider.key_promote", r.promoted.id, `Promoted ${r.promoted.provider} key ${r.promoted.fingerprint}${r.demoted ? `; ${r.demoted.fingerprint} is now standby` : ""}`);
    return r;
  },
});

export const providerKeyRetire = defineVerb({
  name: "provider.key_retire", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, humanOnly: true,
  summary: "Retire a standby key. Its secret is erased; the record stays. Revoke it at the provider as well.",
  parse: (i) => ({ key_id: reqString(i, "key_id", { max: 40 }) }),
  run: async (ctx, p) => {
    const c = await retireCredential(ctx.db, p.key_id, ctx.now);
    await audit(ctx, "provider.key_retire", c.id, `Retired ${c.provider} key ${c.fingerprint}`);
    return { key: c };
  },
});

export const providerKeyVerify = defineVerb({
  name: "provider.key_verify", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: null,
  summary: "Check a key with its provider now and list the models it can use.",
  parse: (i) => ({ key_id: reqString(i, "key_id", { max: 40 }) }),
  run: async (ctx, p) => reverifyCredential(ctx.db, ctx.env.HUB_SECRETS_KEY, p.key_id, ctx.now),
  renderForm: (r: { ok: boolean; error: string | null; models: string[] }) => r.ok
    ? `<h1>The key works</h1><p>It can use ${r.models.length} models.</p><p><a href="/admin/models">Back to models and keys</a></p>`
    : `<h1>The key failed its check</h1><p>${esc(r.error ?? "")}</p><p><a href="/admin/models">Back to models and keys</a></p>`,
});

export const modelRouteSet = defineVerb({
  name: "model.route_set", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, humanOnly: true,
  summary: "Choose the provider and model that serve one purpose (deep, reasoning, fast, code) for the whole hub.",
  parse: (i) => ({ purpose: reqString(i, "purpose", { max: 40 }), provider: reqString(i, "provider", { max: 40 }), model: reqString(i, "model", { max: 100 }) }),
  run: async (ctx, p) => {
    await setRoute(ctx.db, { ...p, tenant_id: null, updated_by: ctx.identity!.id }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "model.route_set", target_kind: "model_route", target_id: p.purpose, summary: `Purpose ${p.purpose} now uses ${p.provider} ${p.model}` }, ctx.now);
    return { ok: true };
  },
});

export const modelTest = defineVerb({
  name: "model.test", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: null,
  summary: "Send a one-line test prompt through a purpose's route and report what answered and how fast.",
  parse: (i) => ({ purpose: reqString(i, "purpose", { max: 40 }), prompt: optString(i, "prompt", { max: 500 }) }),
  run: async (ctx, p) => ask(ctx.env, p.purpose, p.prompt ?? "Reply with exactly: ok", { identity_id: ctx.identity!.id, maxOutputTokens: 2000 }),
  renderForm: (r: Answer) => `<h1>${esc(r.purpose)} answered</h1><p>${esc(r.provider)} <code>${esc(r.model)}</code>, key <code>${esc(r.key_fingerprint)}</code>, ${r.ms} ms.</p><pre>${esc(r.text)}</pre><p><a href="/admin/models">Back to models and keys</a></p>`,
});
