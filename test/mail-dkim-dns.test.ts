import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { createDkimResolver, verifyIndependentDkim } from "../src/mail/dkim";

const name = "test._domainkey.example.com";
const target = "selector1.example-com._domainkey.provider.example";
const txt = (record = fixtures.record) => record.match(/.{1,200}/g)!.map((s) => `"${s}"`).join(" ");
const key = (owner = target, data = txt()) => ({ name: owner, type: 16, data });
const alias = (owner = name, to = target) => ({ name: owner, type: 5, data: to });
function response(question: string, answers: unknown[], extra = {}) {
  return Response.json({ Status: 0, TC: false, Question: [{ name: question, type: 16 }], Answer: answers, ...extra },
    { headers: { "content-type": "application/dns-json" } });
}
const proof = (lookup: ReturnType<typeof createDkimResolver>, raw = fixtures.valid) => verifyIndependentDkim(
  new TextEncoder().encode(raw), "member@example.com", Date.parse(fixtures.now) + 120_000, lookup);

describe("trusted bounded DKIM key delegation", () => {
  it.each([false, true])("verifies original signed mail through provider-style CNAME (bundled=%s)", async (bundled) => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const u = new URL(String(url));
      expect(u.origin + u.pathname).toBe("https://cloudflare-dns.com/dns-query");
      expect(u.searchParams.get("type")).toBe("TXT");
      expect(options?.redirect).toBe("error");
      const q = u.searchParams.get("name")!;
      if (q === name) return response(name.toUpperCase() + ".", bundled
        ? [key(target.toUpperCase() + "."), alias(name, target.toUpperCase() + ".")] : [alias(name, target + ".")]);
      expect(q).toBe(target);
      return response(q, [key()]);
    });
    expect(await proof(createDkimResolver(fetcher))).toMatchObject({ authentication: "pass", domain: "example.com" });
    expect(fetcher).toHaveBeenCalledTimes(bundled ? 1 : 2);
  });

  it("decodes escaped/split TXT into a real cryptographically valid Ed25519 key", async () => {
    const fetcher = vi.fn(async () => response(name, [key(name, txt(fixtures.edRecord).replace("v=DKIM1", "v=\\068KIM1"))]));
    expect((await proof(createDkimResolver(fetcher), fixtures.ed25519)).authentication).toBe("pass");
  });

  it("supports printable literal escapes and decimal bytes, not executable decoding", async () => {
    const data = '"v=DKIM1; p=\\065\\066\\067\\=; note=\\\"quoted\\\"\\\\"';
    expect(await createDkimResolver(async () => response(name, [key(name, data)]))(name, "TXT"))
      .toEqual([['v=DKIM1; p=ABC=; note="quoted"\\']]);
  });

  it.each([
    ["ambiguous aliases", [alias(), alias(name, "other.example")]],
    ["duplicate alias", [alias(), alias()]],
    ["alias with TXT", [alias(), key(name)]],
    ["TXT with alias", [key(name), alias()]],
    ["unrelated TXT", [key(name), key()]],
    ["unrelated alias", [alias(), key(), alias("unrelated.example", "other.example")]],
    ["missing connected answer", [key()]],
    ["self cycle", [alias(name, name)]],
    ["bundled cycle", [alias(), alias(target, name)]],
    ["URL target", [alias(name, "https://attacker.example/key")]],
    ["control target", [alias(name, "bad.example\n")]],
    ["empty label", [alias(name, "bad..example")]],
    ["long label", [alias(name, "a".repeat(64) + ".example")]],
    ["unsupported answer", [{ name, type: 1, data: "127.0.0.1" }]],
    ["null answer", [null]],
  ])("rejects %s without accepting any key", async (_, answers) => {
    const fetcher = vi.fn(async () => response(name, answers as unknown[]));
    expect((await proof(createDkimResolver(fetcher))).authentication).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cycles spanning separate queries without revisiting a name", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const q = new URL(String(url)).searchParams.get("name")!;
      return response(q, [alias(q, q === name ? target : name)]);
    });
    await expect(createDkimResolver(fetcher)(name, "TXT")).rejects.toThrow("cycle");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([4, 5])("bounds bundled chain at four aliases (hops=%s)", async (hops) => {
    const owners = [name, ...Array.from({ length: hops }, (_, i) => `key${i}.provider.example`)];
    const answers = owners.slice(0, -1).map((owner, i) => alias(owner, owners[i + 1]!));
    const lookup = createDkimResolver(async () => response(name, [...answers, key(owners[hops]!)]));
    expect((await proof(lookup)).authentication).toBe(hops === 4 ? "pass" : "unknown");
  });

  it("shares six actual network requests across signatures and CNAME followups", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const q = new URL(String(url)).searchParams.get("name")!;
      return response(q, q === name ? [alias()] : [key()]);
    });
    const lookup = createDkimResolver(fetcher);
    for (let i = 0; i < 3; i++) expect(await lookup(name, "TXT")).toEqual([fixtures.record.match(/.{1,200}/g)]);
    await expect(lookup(name, "TXT")).rejects.toThrow("budget");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("keeps a shared five-second deadline even with successful queries", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000);
      const fetcher = vi.fn(async () => response(name, [key(name)]));
      const lookup = createDkimResolver(fetcher);
      await lookup(name, "TXT");
      clock.mockReturnValue(6001);
      await expect(lookup(name, "TXT")).rejects.toThrow("budget");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it("does not let key delegation change signer alignment or body verification", async () => {
    for (const raw of [fixtures.unaligned, fixtures.valid.replace("Original body.", "Forged body.")]) {
      const fetcher = async (url: RequestInfo | URL) => {
        const q = new URL(String(url)).searchParams.get("name")!;
        return response(q, [alias(q, target), key()]);
      };
      expect((await proof(createDkimResolver(fetcher), raw)).authentication).toBe("unknown");
    }
  });

  it.each(['"bad\\12"', '"bad\\999"', '"bad\\000"', '"bad\\127"', '"unterminated',
    '"trailing\\', 'unquoted', '"one""two"', '"one" ', '"line\nbreak"', '"unicode é"',
    `"${"x".repeat(256)}"`, Array(33).fill('"x"').join(" "), `"${"x".repeat(8192)}"`])("rejects malformed/oversized TXT %s", async (data) => {
    await expect(createDkimResolver(async () => response(name, [key(name, data)]))(name, "TXT")).rejects.toThrow();
  });

  it.each([
    { Status: 2 }, { TC: true }, { TC: "false" }, { Question: [{ name: target, type: 16 }] },
    { Question: [{ name, type: 5 }] }, { Question: [null] }, { Answer: [] },
    { Answer: Array(17).fill(key(name)) },
  ])("rejects invalid response metadata %j", async (extra) => {
    await expect(createDkimResolver(async () => response(name, [key(name)], extra))(name, "TXT")).rejects.toThrow();
  });

  it("rejects a late fetch result even if the transport ignores abort", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000);
      const fetcher = async () => { clock.mockReturnValue(6001); return response(name, [key(name)]); };
      await expect(createDkimResolver(fetcher)(name, "TXT")).rejects.toThrow("budget");
    } finally { clock.mockRestore(); }
  });

  it("fails closed when delegated target is unavailable, truncated or redirects", async () => {
    for (const status of ["nxdomain", "truncated", "redirect", "oversized"]) {
      const fetcher = vi.fn(async (url: RequestInfo | URL) => {
        const q = new URL(String(url)).searchParams.get("name")!;
        if (q === name) return response(q, [alias()]);
        if (status === "redirect") return new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
        if (status === "oversized") return new Response("x".repeat(16385), { headers: { "content-type": "application/dns-json" } });
        return response(q, [key()], status === "nxdomain" ? { Status: 3 } : { TC: true });
      });
      expect((await proof(createDkimResolver(fetcher))).authentication).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("requires the alias target's own matching DNS question on followup", async () => {
    const fetcher = vi.fn(async () => response(name, fetcher.mock.calls.length === 1 ? [alias()] : [key()]));
    await expect(createDkimResolver(fetcher)(name, "TXT")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed on revoked or multiple keys at a delegated name", async () => {
    const revoked = key(target, '"v=DKIM1; p="');
    for (const records of [[revoked], [key(), key()], [key(), revoked], [revoked, key()]]) {
      expect((await proof(createDkimResolver(async () => response(name, [alias(), ...records])))).authentication).toBe("unknown");
    }
  });
});
