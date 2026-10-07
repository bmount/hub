import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { open, seal, fingerprint } from "../src/models/secretbox";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential, listCredentials, promoteCredential, resolveRoute, retireCredential, setRoute } from "../src/models/store";
import { newerModels } from "../src/models/purposes";
import { ask } from "../src/models/ask";
import { apiPost, cookieHeaders, seedHuman } from "./helpers";

const KEY_A = "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa";
const KEY_B = "sk-testBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbb";
const BAD = "sk-testXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXxxxx";

/** A stand-in for OpenAI: two good keys, one rejected; the Responses API echoes the model it was asked for. */
function fakeOpenAI(seen: Array<{ url: string; auth: string | null; body: unknown }> = []) {
  setModelFetchForTest(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (auth === `Bearer ${BAD}`) return Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.5-pro" }, { id: "gpt-5.4-mini" }] });
    if (url.endsWith("/v1/responses")) {
      const b = JSON.parse(String(init!.body)) as { model: string };
      return Response.json({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: `ok from ${b.model}` }] }], usage: { input_tokens: 7, output_tokens: 3 } });
    }
    return new Response("nope", { status: 404 });
  });
  return seen;
}
afterEach(() => setModelFetchForTest(null));

const add = (secret: string, label = "") => addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label, secret, tenant_id: null, created_by: null }, Date.now());

describe("secretbox", () => {
  it("seals and opens, with a fresh IV each time", async () => {
    const a = await seal(env.HUB_SECRETS_KEY, KEY_A), b = await seal(env.HUB_SECRETS_KEY, KEY_A);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await open(env.HUB_SECRETS_KEY, a)).toBe(KEY_A);
    expect(a.ciphertext).not.toContain("sk-");
  });
  it("shows only a prefix and the last four characters", () => {
    expect(fingerprint(KEY_A)).toBe("sk-test…aaaa".replace("sk-test", "sk-"));
  });
});

describe("provider keys", () => {
  it("checks a key before saving, and refuses a rejected one", async () => {
    fakeOpenAI();
    await expect(add(BAD)).rejects.toThrow(/rejected the key/);
    expect(await listCredentials(env.HUB_DB)).toHaveLength(0);
  });

  it("makes the first key active and the next standby; promote swaps them both ways", async () => {
    fakeOpenAI();
    const a = await add(KEY_A, "first"), b = await add(KEY_B, "second");
    expect([a.status, b.status]).toEqual(["active", "standby"]);
    await promoteCredential(env.HUB_DB, b.id);
    let byId = new Map((await listCredentials(env.HUB_DB)).map((k) => [k.id, k.status]));
    expect([byId.get(a.id), byId.get(b.id)]).toEqual(["standby", "active"]);
    await promoteCredential(env.HUB_DB, a.id);
    byId = new Map((await listCredentials(env.HUB_DB)).map((k) => [k.id, k.status]));
    expect([byId.get(a.id), byId.get(b.id)]).toEqual(["active", "standby"]);
  });

  it("will not retire the active key; retiring a standby erases its secret", async () => {
    fakeOpenAI();
    const a = await add(KEY_A), b = await add(KEY_B);
    await expect(retireCredential(env.HUB_DB, a.id, Date.now())).rejects.toThrow(/promote another key/);
    await retireCredential(env.HUB_DB, b.id, Date.now());
    const row = await env.HUB_DB.prepare("SELECT status, secret_ciphertext FROM provider_credential WHERE id = ?").bind(b.id).first<{ status: string; secret_ciphertext: string }>();
    expect(row).toEqual({ status: "retired", secret_ciphertext: "" });
  });
});

describe("routes and asking", () => {
  it("uses the default model until admin sets another", async () => {
    expect((await resolveRoute(env.HUB_DB, "reasoning", null)).model).toBe("gpt-6.1-sol");
    await setRoute(env.HUB_DB, { purpose: "reasoning", provider: "openai", model: "gpt-5.5-pro", tenant_id: null, updated_by: null }, Date.now());
    await setRoute(env.HUB_DB, { purpose: "reasoning", provider: "openai", model: "gpt-5.4-mini", tenant_id: null, updated_by: null }, Date.now());
    expect(await resolveRoute(env.HUB_DB, "reasoning", null)).toMatchObject({ model: "gpt-5.4-mini", source: "hub" });
  });

  it("asks with the active key, says which model answered, and records the call", async () => {
    const seen = fakeOpenAI();
    await add(KEY_A);
    const r = await ask(env, "fast", "say ok");
    expect(r).toMatchObject({ text: "ok from gpt-6-luna", provider: "openai", model: "gpt-6-luna" });
    expect(seen.at(-1)!.auth).toBe(`Bearer ${KEY_A}`);
    const call = await env.HUB_DB.prepare("SELECT ok, input_tokens, output_tokens FROM model_call WHERE purpose = 'fast'").first();
    expect(call).toEqual({ ok: 1, input_tokens: 7, output_tokens: 3 });
  });

  it("explains what is missing when there is no key", async () => {
    await expect(ask(env, "deep", "hello")).rejects.toThrow(/add one under Models and keys/);
  });
});

describe("newer models", () => {
  it("lists newer GPT families, newest first, without dated snapshots", () => {
    const live = ["gpt-5.5", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-sol-2026-09-30", "o3", "gpt-7-nova"];
    expect(newerModels("gpt-5.5", live)).toEqual(["gpt-7-nova", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
    expect(newerModels("gpt-7-nova", live)).toEqual([]);
    expect(newerModels("o3", live)).toEqual([]);
  });
});

describe("Models and keys page and verbs", () => {
  it("is for root only", async () => {
    const plain = await seedHuman("member@example.com");
    expect((await SELF.fetch("https://pimwell.test/admin/models", { headers: cookieHeaders(plain.token, "pimwell.test") })).status).toBe(404);
  });

  it("adds a key through the form, shows what is in use, and never shows the key", async () => {
    fakeOpenAI();
    const root = await seedHuman("root@example.com", { is_root: true });
    const h = cookieHeaders(root.token, "pimwell.test");
    const before = await (await SELF.fetch("https://pimwell.test/admin/models", { headers: h })).text();
    expect(before).toContain("add an OpenAI key");
    const res = await apiPost("pimwell.test", "provider.key_add", { provider: "openai", label: "hub key", key: KEY_A }, h);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(KEY_A);
    const after = await (await SELF.fetch("https://pimwell.test/admin/models", { headers: h })).text();
    expect(after).toContain("Every purpose has a working route");
    expect(after).toContain(fingerprint(KEY_A));
    expect(after).not.toContain(KEY_A);
    const status = await (await apiPost("pimwell.test", "provider.status", {}, h)).text();
    expect(status).not.toContain(KEY_A);
  });
});
