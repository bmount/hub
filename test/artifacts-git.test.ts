import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactNamespace, ArtifactsRest, clearArtifactTokensForTest } from "../src/code/artifactsRest";
import { artifactPush } from "../src/code/artifactPush";
import { authorizeGit } from "../src/code/gitAccess";
import { saveGitReplay } from "../src/code/gitReplay";
import { cleanupGitStages } from "../src/code/gitStageCleanup";
import { packet, parseAdvertisedRefs, peekCommands, refAllowed, reportOutcomes, validGitRef, ZERO_OID } from "../src/code/gitProtocol";
import { createGitSession, revokeSession } from "../src/db/sessions";
import { createProject } from "../src/db/projects";
import { indexCommitNodes } from "../src/code/gitCommitIndex";
import { HubError } from "../src/errors";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const OID = "1".repeat(40), NEXT = "2".repeat(40);
const update = { oldOid: OID, newOid: NEXT, ref: "refs/heads/main" };
const encode = new TextEncoder();
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }return result;
}
function stream(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part);controller.close(); } });
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream(bytes).pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
const command = (ref = update.ref, oldOid = OID, newOid = NEXT) => `${oldOid} ${newOid} ${ref}`;
const flush = encode.encode("0000");

afterEach(() => { vi.restoreAllMocks(); clearArtifactTokensForTest(); });

describe("Git receive-pack parsing", () => {
  it("parses commands split at every byte and replays the exact original bytes", async () => {
    const bytes = join(packet(`shallow ${OID}\n`), packet(command() + "\0report-status side-band-64k\n"), flush, encode.encode("PACK\0\xff\n"));
    const parsed = await peekCommands(stream(...Array.from(bytes, value => new Uint8Array([value]))));
    expect(parsed.updates).toEqual([update]);expect(parsed.capabilities).toEqual(["report-status", "side-band-64k"]);
    expect(new Uint8Array(await new Response(parsed.stream).arrayBuffer())).toEqual(bytes);
  });
  it("does not count a pack in the same large network chunk against the command limit", async () => {
    const bytes = join(packet(command()), flush, new Uint8Array(5 * 1024 * 1024).fill(255));
    const parsed = await peekCommands(stream(bytes));
    expect(parsed.updates).toEqual([update]);
    const replay = await new Response(parsed.stream).arrayBuffer();
    expect(replay.byteLength).toBe(bytes.byteLength);
    expect(new Uint8Array(await crypto.subtle.digest("SHA-256", replay))).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", await new Response(bytes).arrayBuffer())));
  });
  it.each(["000z", "0001", "0002", "0003", "ffff", "0004", "0010bad", "zzzz"])("rejects malformed framing %s", async value => {
    await expect(peekCommands(stream(encode.encode(value)))).rejects.toThrow();
  });
  it.each([
    "malformed command", command("refs/heads/../private"), command("refs/heads/main.lock"), command("refs/heads/main\nother"),
    command("HEAD"), command("refs/heads/main", "x".repeat(40)), command("refs/heads/main", ZERO_OID, ZERO_OID),
  ])("rejects, rather than skips, malformed command %s", async value => {
    await expect(peekCommands(stream(join(packet(value), flush)))).rejects.toThrow();
  });
  it("rejects duplicate updates and capabilities on a later command", async () => {
    for (const second of [command(), command("refs/heads/other") + "\0report-status"]) {
      await expect(peekCommands(stream(join(packet(command()), packet(second), flush)))).rejects.toThrow();
    }
  });
  it("accepts Git's flush-only authentication probe", async () => {
    const parsed = await peekCommands(stream(flush));expect(parsed.updates).toEqual([]);await parsed.stream.cancel();
  });
  it("parses native v0 advertised peeled refs", () => {
    const refs = parseAdvertisedRefs(join(packet("# service=git-upload-pack\n"), flush, packet(`${OID} HEAD\0symref=HEAD:refs/heads/main\n`), packet(`${OID} refs/tags/v1\n`), packet(`${NEXT} refs/tags/v1^{}\n`), flush));
    expect(refs).toEqual([{ name: "refs/tags/v1", target: OID }, { name: "refs/tags/v1^{}", target: NEXT }]);
  });
  it("permits deletion commands for policy inspection without needing a pack", async () => {
    const parsed = await peekCommands(stream(join(packet(command(update.ref, OID, ZERO_OID)), flush)));
    expect(parsed.updates[0]!.newOid).toBe(ZERO_OID);await parsed.stream.cancel();
  });
  it("restricts refs without allowing reserved namespaces or sibling prefixes", () => {
    expect(refAllowed("refs/heads/agent/work", ["refs/heads/agent/"])).toBe(true);
    for (const ref of ["refs/heads/agent-escape", "refs/heads/main", "refs/ardi/forks/x", "refs/pimwell/log/x", "refs/ardi", "refs/pimwell"])
      expect(refAllowed(ref, ["refs/heads/agent/"])).toBe(false);
    expect(refAllowed(update.ref, [])).toBe(false);expect(refAllowed(update.ref)).toBe(true);
    expect(validGitRef("refs/heads/feature/topic")).toBe(true);
  });
  it("records per-ref rejection even with a successful HTTP response", () => {
    const body = join(packet("unpack ok\n"), packet("ng refs/heads/main protected history\n"), flush);
    expect(reportOutcomes(body, [update])).toEqual([{ ...update, outcome: "ng", reason: "protected history" }]);
  });
  it("parses side-band status split across packets, ignoring progress", () => {
    const report = join(packet("unpack ok\n"), packet("ok refs/heads/main\n"), flush);
    const band = (data: Uint8Array, channel: number) => {
      const payload = join(new Uint8Array([channel]), data), header = encode.encode((payload.length + 4).toString(16).padStart(4, "0"));
      return join(header, payload);
    };
    const bytes = join(band(report.slice(0, 7), 1), band(encode.encode("processing...\n"), 2), band(report.slice(7), 1), flush);
    expect(reportOutcomes(bytes, [update])).toEqual([{ ...update, outcome: "ok" }]);
  });
  it.each([new Uint8Array(), encode.encode("HTTP 200"), join(packet("unpack ok\n"), flush), join(packet("unpack failed\n"), packet("ok refs/heads/main\n"), flush)])(
    "keeps missing or invalid reports unknown", bytes => expect(reportOutcomes(bytes, [update])).toEqual([{ ...update, outcome: "unknown" }]),
  );
});

describe("Artifacts REST transport", () => {
  const account = "0".repeat(32), apiToken = "synthetic-api-credential";
  const configured = () => new ArtifactsRest({ ...env, ARTIFACTS_ACCOUNT_ID: account, ARTIFACTS_API_TOKEN: apiToken });
  const issued = () => ({ plaintext: `art_v1_${"a".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 300}`, expires_at: new Date(Date.now() + 300_000).toISOString() });
  it("bounds large repository forks and native Git, including transient failure/retry", async () => {
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(url).endsWith("/fork")) return Response.json({ success: true, result: {} });
      if (String(url).endsWith("/tokens")) return Response.json({ success: true, result: issued() });
      if (fail) { fail = false; throw new Error("private upstream detail"); }
      return new Response("0000");
    });
    const api = configured();
    await api.fork("acme", "site", "pimwell-stage-test");
    expect(deadlines).toHaveBeenCalledWith(90_000);
    const request = new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST" });
    await expect(api.git("acme", "site", "git-receive-pack", request, null, true)).rejects.toThrow("git ls-remote");
    expect(deadlines).toHaveBeenCalledWith(120_000);
    expect((await api.git("acme", "site", "git-receive-pack", request, null, true)).status).toBe(200);
  });
  it("uses separate namespaces, not concatenated organization and repository names", () => {
    const api = configured();
    expect(api.remote(artifactNamespace("red--blue"), "app")).toContain("/git/red--blue/app.git");
    expect(api.remote(artifactNamespace("red"), "blue--app")).toContain("/git/red/blue--app.git");
    expect(artifactNamespace("r")).toBe("r_");expect(() => artifactNamespace("red/blue")).toThrow();
  });
  it("caches read and write tokens separately and mints them using the private API credential", async () => {
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiToken}`);
      expect(init?.redirect).toBe("manual");return Response.json({ success: true, result: issued() });
    });
    const api = configured();
    await api.repoToken("acme", "site", "read");await api.repoToken("acme", "site", "read");await api.repoToken("acme", "site", "write");
    expect(fake).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fake.mock.calls[0]![1]!.body as string)).toEqual({ repo: "site", scope: "read", ttl: 300 });
    expect(JSON.parse(fake.mock.calls[1]![1]!.body as string).scope).toBe("write");
  });
  it("does not send client credentials, cookies, or claimed identities to storage", async () => {
    const token = issued();
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://api.cloudflare.com/")) return Response.json({ success: true, result: token });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token.plaintext}`);
      expect(headers.get("content-encoding")).toBe("gzip");
      for (const name of ["cookie", "x-ardi-principal", "x-hub-internal"]) expect(headers.get(name)).toBeNull();
      expect(init?.redirect).toBe("manual");return new Response("synthetic Git response");
    });
    const request = new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", headers: { authorization: "Basic client", cookie: "private", "content-encoding": "gzip", "x-ardi-principal": "admin", "x-hub-internal": "forged" } });
    const response = await configured().git("acme", "site", "git-receive-pack", request, null, true);
    expect(await response.text()).toBe("synthetic Git response");expect(String(fake.mock.calls[1]![0])).toBe(`https://${account}.artifacts.cloudflare.net/git/acme/site.git/git-receive-pack`);
  });
  it("normalizes advertised HEAD to the Artifacts default branch tip", async () => {
    const token = issued(), stale = "1".repeat(40), main = "2".repeat(40);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const text = String(url);
      if (text.endsWith("/tokens")) return Response.json({ success: true, result: token });
      if (text.includes("/git/acme/site.git/info/refs")) return new Response(join(packet("# service=git-upload-pack\n"), flush, packet(`${stale} HEAD\0multi_ack symref=HEAD:refs/heads/old agent=x\n`), packet(`${main} refs/heads/main\n`), packet(`${stale} refs/heads/old\n`), flush));
      if (text.endsWith("/repos/site")) return Response.json({ success: true, result: { name: "site", remote: `https://${account}.artifacts.cloudflare.net/git/acme/site.git`, description: null, default_branch: "main", read_only: false } });
      if (text.includes("/repos/site/log?")) return Response.json({ success: true, result: [{ hash: main }] });
      throw new Error(`unexpected ${text} ${init?.method ?? "GET"}`);
    });
    const response = await configured().git("acme", "site", "info/refs", new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack"), null, false);
    const advertised = new TextDecoder().decode(await response.arrayBuffer());
    expect(advertised).toContain(`${main} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=x\n`);
    expect(advertised).toContain(`${stale} refs/heads/old\n`);
  });
  it("normalizes compressed v2 ls-refs HEAD without decoding pack responses", async () => {
    const token = issued(), stale = "1".repeat(40), main = "2".repeat(40), plain = join(packet("command=ls-refs\n"), flush, packet("symrefs\n"), flush), compressed = await gzip(plain);
    let sawUpstreamBody = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const text = String(url);
      if (text.endsWith("/tokens")) return Response.json({ success: true, result: token });
      if (text.includes("/git/acme/site.git/git-upload-pack")) {
        sawUpstreamBody = (await new Response(init?.body as BodyInit).arrayBuffer()).byteLength === compressed.length;
        return new Response(join(packet(`${stale} HEAD symref-target:refs/heads/old\n`), packet(`${main} refs/heads/main\n`), flush));
      }
      if (text.endsWith("/repos/site")) return Response.json({ success: true, result: { name: "site", remote: `https://${account}.artifacts.cloudflare.net/git/acme/site.git`, description: null, default_branch: "main", read_only: false } });
      if (text.includes("/repos/site/log?")) return Response.json({ success: true, result: [{ hash: main }] });
      throw new Error(`unexpected ${text} ${init?.method ?? "GET"}`);
    });
    const body = stream(compressed);
    const response = await configured().git("acme", "site", "git-upload-pack", new Request("https://acme.pimwell.test/site.git/git-upload-pack", { method: "POST", headers: { "content-encoding": "gzip" } }), body, false);
    expect(sawUpstreamBody).toBe(true);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain(`${main} HEAD symref-target:refs/heads/main\n`);
  });
  it("deletes only the exact owned project repository and handles a missing repository on retry", async () => {
    const api = configured(), ownership = "Pimwell tenant tid project pid";
    let exists = true;
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/acme/repos/site`);
      if (!exists) return new Response("", { status: 404 });
      if (init?.method === "DELETE") { exists = false; return Response.json({ success: true, result: {} }); }
      return Response.json({ success: true, result: { name: "site", remote: api.remote("acme", "site"), description: ownership } });
    });
    await expect(api.deleteProject("acme", "site", "another project")).rejects.toThrow("ownership mismatch");
    expect(fake.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    await api.deleteProject("acme", "site", ownership);
    await api.deleteProject("acme", "site", ownership);
    expect(fake.mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(1);
  });
  it("does not include upstream error messages or credentials in errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: false, errors: [{ message: apiToken }] }, { status: 403 }));
    const error = await configured().repoToken("acme", "site", "read").catch(e => e);
    expect(error.message).toContain("Artifacts request failed (POST; HTTP 403)");
    expect(error.message).not.toContain(apiToken);
  });
  it("includes only numeric codes and validated request IDs, even in HTTP 200 failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: false, errors: [{ code: 10000, message: apiToken }, { code: apiToken }] }, { headers: { "cf-ray": "0123456789abcdef-DFW" } }));
    const error = await configured().create("acme", "site", "owned").catch(e => e);
    expect(error.message).toContain("create repository; HTTP 200; codes 10000; request 0123456789abcdef-DFW");
    expect(error.message).not.toContain(apiToken);
    vi.mocked(fetch).mockResolvedValue(Response.json({ success: false }, { status: 403, headers: { "cf-ray": apiToken } }));
    expect((await configured().create("acme", "site", "owned").catch(e => e)).message).not.toContain(apiToken);
  });
  it("refuses a repository remote pointing elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, result: { name: "site", remote: "https://attacker.invalid/site.git" } }));
    await expect(configured().info("acme", "site")).rejects.toThrow("mapping mismatch");
  });
});

describe("live Pimwell Git authorization", () => {
  const basic = (token: string) => `Basic ${btoa(`claimed-admin:${token}`)}`;
  async function setup(role: "admin" | "member" | "reader" = "member") {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("git@example.invalid", { memberships: [{ tenant_id: tenant.id, role }] });
    await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Website" }, Date.now());
    const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: tenant.id, label: "synthetic laptop" }, Date.now());
    return { tenant, human, git };
  }
  it("uses the credential's actual identity, not the Basic username", async () => {
    const { human, git } = await setup();
    expect(await authorizeGit(env, basic(git.token), "acme", "site")).toMatchObject({ identity: { id: human.identity.id }, write: true });
  });
  it("allows a reader to fetch, not push", async () => {
    const { git } = await setup("reader");expect((await authorizeGit(env, basic(git.token), "acme", "site"))?.write).toBe(false);
  });
  it("rechecks revocation and membership for every request", async () => {
    const { tenant, human, git } = await setup();
    expect(await authorizeGit(env, basic(git.token), "acme", "site")).not.toBeNull();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(human.identity.id, tenant.id).run();
    expect(await authorizeGit(env, basic(git.token), "acme", "site")).toBeNull();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'active' WHERE identity_id = ? AND tenant_id = ?").bind(human.identity.id, tenant.id).run();
    await revokeSession(env.HUB_DB, git.session.id, Date.now());expect(await authorizeGit(env, basic(git.token), "acme", "site")).toBeNull();
  });
  it("rejects browser credentials, wrong tenants, unknown repos, and malformed authentication", async () => {
    const { human, git } = await setup();await seedTenant("other");
    for (const auth of [null, "Basic !!!", "Basic bm9jb2xvbg==", basic(human.token)]) expect(await authorizeGit(env, auth, "acme", "site")).toBeNull();
    expect(await authorizeGit(env, basic(git.token), "other", "site")).toBeNull();expect(await authorizeGit(env, basic(git.token), "acme", "missing")).toBeNull();
  });
  it("caps an agent by its sponsor and checks the parent API token", async () => {
    const { tenant, human } = await setup("admin");
    const agent = await seedAgent(tenant, human.identity);
    expect((await authorizeGit(env, basic(agent.token), "acme", "site"))?.write).toBe(true);
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ? AND tenant_id = ?").bind(human.identity.id, tenant.id).run();
    expect((await authorizeGit(env, basic(agent.token), "acme", "site"))?.write).toBe(false);
    await env.HUB_DB.prepare("UPDATE api_token SET revoked_at = ? WHERE id = ?").bind(Date.now(), agent.session.parent_token_id).run();
    expect(await authorizeGit(env, basic(agent.token), "acme", "site")).toBeNull();
  });
});

describe("Artifacts push recovery boundaries", () => {
  const account = "0".repeat(32), apiToken = "synthetic-api-credential", basic = (token: string) => `Basic ${btoa(`ignored:${token}`)}`;
  const oid = (n: number) => n.toString(16).padStart(40, "0");
  async function grant(named = false) {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("git@example.invalid", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Website" }, Date.now());
    const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: tenant.id, label: "synthetic laptop" }, Date.now());
    if (named) {
      const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'site'").bind(tenant.id).first<string>("id");
      await env.HUB_DB.prepare("INSERT INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) VALUES (?, ?, 'secondary', 'site-secondary', 0, ?)").bind(tenant.id, project, Date.now()).run();
    }
    return { grant: (await authorizeGit(env, basic(git.token), "acme", named ? "site/secondary" : "site"))!, human, git };
  }
  function bucket() {
    const stored = new Map<string, Uint8Array>();
    return {
      stored, deleted: [] as string[],
      async get(key: string) { const value = stored.get(key);return value ? { body: stream(value) } : null; },
      async delete(key: string) { this.deleted.push(key);stored.delete(key); },
      async createMultipartUpload(key: string) {
        const chunks: Uint8Array[] = [];
        return { async uploadPart(partNumber: number, value: Uint8Array) { chunks[partNumber - 1] = value.slice();return { partNumber, etag: `p${partNumber}` }; }, async complete() { stored.set(key, join(...chunks)); }, async abort() {} };
      },
    } as any;
  }
  it("saves replay packs through native R2 multipart upload", async () => {
    const r2 = bucket(), first = new Uint8Array(8 * 1024 * 1024).fill(1), second = new Uint8Array([2, 3, 4]);
    await saveGitReplay(r2, "k", stream(first, second));
    expect(r2.stored.get("k")!.byteLength).toBe(first.length + second.length);
    expect(r2.stored.get("k")!.slice(-3)).toEqual(second);
  });
  it("cleans only disposable expired staging rows and retains unknown publishing rows", async () => {
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
    const states = ["complete", "refused", "staging", "publishing", "unknown"], now = Date.now();
    for (let i = 0; i < ids.length; i++) await env.HUB_DB.prepare("INSERT INTO git_push (id, tenant_id, project_id, namespace, repo, shadow, replay_key, updates_json, state, created_at) VALUES (?, 'deleted-tenant', 'deleted-project', 'acme', 'site', ?, ?, '[]', ?, ?)")
      .bind(ids[i], `pimwell-stage-${ids[i]}`, `r${i}`, states[i], now - 25 * 3600_000).run();
    const r2 = bucket();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const repo = decodeURIComponent(String(url).match(/\/repos\/([^/?]+)/)![1]!);
      if (init?.method === "DELETE") return Response.json({ success: true, result: {} });
      return Response.json({ success: true, result: { name: repo, remote: `https://${account}.artifacts.cloudflare.net/git/acme/${repo}.git`, description: `Pimwell temporary validation ${repo.slice("pimwell-stage-".length)}`, default_branch: "main", read_only: false } });
    });
    const result = await cleanupGitStages({ ...env, ARTIFACTS_ACCOUNT_ID: account, ARTIFACTS_API_TOKEN: apiToken, GIT_PUSH_STAGING: r2 }, now);
    expect(result).toEqual({ cleaned: 3, failed: 0 });
    const rows = (await env.HUB_DB.prepare("SELECT state, replay_key FROM git_push ORDER BY id").all<{ state: string; replay_key: string }>()).results;
    expect(rows).toEqual([{ state: "complete", replay_key: "" }, { state: "refused", replay_key: "" }, { state: "staging", replay_key: "" }, { state: "publishing", replay_key: "r3" }, { state: "unknown", replay_key: "r4" }]);
  });
  it.each(["fork", "stage", "publish"])("reports %s failures with actionable readback and durable ambiguity", async failure => {
    const { grant: g, git } = await grant(), r2 = bucket();
    const body = join(packet(`${ZERO_OID} ${NEXT} refs/heads/main\0report-status side-band-64k\n`), flush, encode.encode("PACK"));
    const api = {
      async fork() { if (failure === "fork") throw new HubError(503, "unavailable", "secret upstream text"); },
      async deleteTemporary() {},
      async readCommit() { return { hash: NEXT }; },
      async git(_ns: string, repo: string, tail: string, _request: Request, supplied: ReadableStream<Uint8Array> | null) {
        if (tail === "info/refs") return new Response(join(packet(`${NEXT} refs/heads/main\n`), flush));
        await new Response(supplied).arrayBuffer();
        if (failure === "stage" || (failure === "publish" && repo === "site")) throw new HubError(503, "unavailable", "secret upstream text");
        return new Response(join(packet("unpack ok\n"), packet("ok refs/heads/main\n"), flush));
      },
    };
    const res = await artifactPush(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", headers: { authorization: basic(git.token) }, body }), { ...env, GIT_PUSH_STAGING: r2 }, g, api as any);
    const outcomes = reportOutcomes(new Uint8Array(await res.arrayBuffer()), [{ oldOid: ZERO_OID, newOid: NEXT, ref: "refs/heads/main" }]);
    expect(outcomes[0]!.outcome).toBe("ng");
    expect(outcomes[0]!.reason).toContain("git ls-remote");
    expect(outcomes[0]!.reason).not.toContain("secret");
    const row = await env.HUB_DB.prepare("SELECT state, outcomes_json FROM git_push").first<{ state: string; outcomes_json: string }>();
    expect(row!.state).toBe(failure === "publish" ? "unknown" : "refused");
    expect(JSON.parse(row!.outcomes_json)[0].reason).toBe(outcomes[0]!.reason);
    expect(r2.deleted.length).toBe(failure === "publish" ? 0 : 1);
  });
  it("does not create recovery rows for flush-only authenticated probes", async () => {
    const { grant: g } = await grant(), r2 = bucket(), api = { fork: vi.fn(), git: vi.fn() };
    const res = await artifactPush(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", body: flush }), { ...env, GIT_PUSH_STAGING: r2 }, g, api as any);
    expect(res.status).toBe(200);expect(api.git).not.toHaveBeenCalled();
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) n FROM git_push").first<{ n: number }>())!.n).toBe(0);
  });
  it.each([false, true])("indexes preserved rejected fork tips even when the staging advertisement lacks the renamed ref (named=%s)", async named => {
    const { grant: g, git } = await grant(named), r2 = bucket(), old = oid(1), rewritten = oid(5);
    const body = join(packet(`${old} ${rewritten} refs/heads/main\0report-status\n`), flush, encode.encode("PACK"));
    let publishedRef = "";
    const api = {
      async fork() {},
      async deleteTemporary() {},
      async log(_ns: string, _repo: string, ref: string) { return [{ hash: ref, parents: [] }]; },
      async readCommit(_ns: string, repo: string, hash: string) {
        if (repo === (named ? "site-secondary" : "site")) throw new HubError(404, "not_found", "missing");
        if (hash !== rewritten) throw new HubError(404, "not_found", "missing");
        return { hash, treeHash: oid(6), parents: [], committedAt: 50, message: "preserved\n", author: { name: "a", email: "a@example.invalid" }, committer: { name: "c", email: "c@example.invalid" }, authoredAt: 50 };
      },
      async git(_ns: string, _repo: string, tail: string, _request: Request, supplied: ReadableStream<Uint8Array> | null) {
        if (tail === "info/refs") return new Response(join(packet(`${rewritten} refs/heads/main\n`), flush));
        const parsed = await peekCommands(supplied!);await new Response(parsed.stream).arrayBuffer();
        publishedRef = parsed.updates[0]!.ref;
        return new Response(join(packet("unpack ok\n"), ...parsed.updates.map(u => packet(`ok ${u.ref}\n`)), flush));
      },
    };
    const res = await artifactPush(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", headers: { authorization: basic(git.token) }, body }), { ...env, GIT_PUSH_STAGING: r2 }, g, api as any);
    expect(res.status).toBe(200);expect(publishedRef).toMatch(/^refs\/ardi\/forks\/heads\/main\//);
    expect((await env.HUB_DB.prepare(named ? "SELECT oid FROM repository_commit WHERE repo = 'secondary'" : "SELECT oid FROM git_commit").first<{ oid: string }>())!.oid).toBe(rewritten);
    expect((await env.HUB_DB.prepare("SELECT target FROM code_event WHERE kind = 'commit'").first<{ target: string }>())!.target).toBe(rewritten);
  });

  it("deletes any branch but main, merged or not, and refuses main itself", async () => {
    const { grant: g, git } = await grant(), r2 = bucket();
    const [root, tip, merged, unmerged] = [oid(1), oid(2), oid(1), oid(7)];
    await indexCommitNodes(env.HUB_DB, g.tenant.id, g.project.id, [
      { hash: root, treeHash: oid(11), parents: [], committedAt: 1 }, { hash: tip, treeHash: oid(12), parents: [root], committedAt: 2 },
    ] as any);
    const deletions = [["refs/heads/old-feature", merged], ["refs/heads/stray", unmerged], ["refs/heads/main", tip]] as const;
    const body = join(...deletions.map(([ref, old], i) => packet(`${old} ${ZERO_OID} ${ref}${i === 0 ? "\0report-status delete-refs" : ""}\n`)), flush);
    const published: string[] = [];
    const api = {
      async fork() {}, async deleteTemporary() {},
      async info() { return { default_branch: "main" }; },
      async log(_ns: string, repo: string, ref: string) { return repo === "site" && ref === "main" ? [{ hash: tip, parents: [root] }] : []; },
      async readCommit() { throw new HubError(404, "not_found", "missing"); },
      async git(_ns: string, repo: string, tail: string, _request: Request, supplied: ReadableStream<Uint8Array> | null) {
        if (tail === "info/refs") return new Response(flush);
        const parsed = await peekCommands(supplied!);await new Response(parsed.stream).arrayBuffer();
        if (repo === "site") published.push(...parsed.updates.map(u => u.ref));
        return new Response(join(packet("unpack ok\n"), ...parsed.updates.map(u => packet(`ok ${u.ref}\n`)), flush));
      },
    };
    const res = await artifactPush(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", headers: { authorization: basic(git.token) }, body }), { ...env, GIT_PUSH_STAGING: r2 }, g, api as any);
    expect(res.status).toBe(200);
    const report = await res.text();
    expect(report).toContain("ok refs/heads/old-feature");
    expect(report).toContain("ok refs/heads/stray");
    expect(report).toContain("ng refs/heads/main the default branch cannot be deleted");
    expect(published).toEqual(["refs/heads/old-feature", "refs/heads/stray"]);
    expect((await env.HUB_DB.prepare("SELECT state FROM git_push").first<{ state: string }>())!.state).toBe("complete");
  });

  it.each([false, true])("indexes tag-only peeled history and non-head commit refs with real attribution (named=%s)", async named => {
    const { grant: g, human, git } = await grant(named), r2 = bucket(), tagObject = oid(9), tagCommit = oid(3), parent = oid(2), change = oid(4);
    const updates = [{ oldOid: ZERO_OID, newOid: tagObject, ref: "refs/tags/v1" }, { oldOid: ZERO_OID, newOid: change, ref: "refs/changes/1" }];
    const body = join(packet(`${ZERO_OID} ${tagObject} refs/tags/v1\0report-status\n`), packet(`${ZERO_OID} ${change} refs/changes/1\n`), flush, encode.encode("PACK"));
    const commits = new Map([[tagCommit, { parents: [parent], message: "tagged\n", committedAt: 30 }], [parent, { parents: [], message: "parent\n", committedAt: 20 }], [change, { parents: [], message: "change\n", committedAt: 40 }]]);
    const api = {
      async fork() {},
      async deleteTemporary() {},
      async log() { return []; },
      async readCommit(_ns: string, repo: string, hash: string) {
        if (repo === (named ? "site-secondary" : "site")) throw new HubError(404, "not_found", "missing");
        const c = commits.get(hash);if (!c) throw new HubError(404, "not_found", "missing");
        return { hash, treeHash: oid(Number.parseInt(hash.at(-1)!, 16) + 20), parents: c.parents, committedAt: c.committedAt, message: c.message, author: { name: "a", email: "a@example.invalid" }, committer: { name: "c", email: "c@example.invalid" }, authoredAt: c.committedAt };
      },
      async git(_ns: string, repo: string, tail: string, request: Request, supplied: ReadableStream<Uint8Array> | null) {
        if (tail === "info/refs") return new Response(join(packet(`${tagObject} refs/tags/v1\n`), packet(`${tagCommit} refs/tags/v1^{}\n`), packet(`${change} refs/changes/1\n`), flush));
        const parsed = await peekCommands(supplied!);await new Response(parsed.stream).arrayBuffer();
        return new Response(join(packet("unpack ok\n"), ...parsed.updates.map(u => packet(`ok ${u.ref}\n`)), flush));
      },
    };
    const res = await artifactPush(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", headers: { authorization: basic(git.token) }, body }), { ...env, GIT_PUSH_STAGING: r2 }, g, api as any);
    expect(res.status).toBe(200);
    const indexed = (await env.HUB_DB.prepare(named ? "SELECT oid FROM repository_commit WHERE repo = 'secondary' ORDER BY oid" : "SELECT oid FROM git_commit ORDER BY oid").all<{ oid: string }>()).results.map(r => r.oid);
    expect(indexed).toEqual([parent, tagCommit, change].sort());
    const event = await env.HUB_DB.prepare("SELECT identity_id, target FROM code_event WHERE kind = 'commit' ORDER BY target LIMIT 1").first<{ identity_id: string; target: string }>();
    expect(event?.identity_id).toBe(human.identity.id);
  });
});
