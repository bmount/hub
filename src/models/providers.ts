// Model providers: how to check a key, list models, and ask a question (admin spec 10).
// Outbound calls go through `modelFetch`, so tests can stand in for the provider.

let modelFetch: typeof fetch = (input, init) => fetch(input, init);
export function setModelFetchForTest(f: typeof fetch | null): void {
  modelFetch = f ?? ((input, init) => fetch(input, init));
}

export type AskResult = { text: string; inputTokens: number | null; outputTokens: number | null };

export interface Provider {
  id: string;
  name: string;
  /** Plain-language hint shown where a key is pasted. */
  keyHint: string;
  looksLikeKey: (s: string) => boolean;
  /** Ok and the model ids the key can use, or the provider's error. */
  verify: (key: string) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
  ask: (key: string, model: string, input: string, opts: { instructions?: string; maxOutputTokens?: number }) => Promise<AskResult>;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return `${res.status}: ${body.error?.message ?? res.statusText}`.slice(0, 300);
  } catch {
    return `${res.status}: ${res.statusText}`;
  }
}

const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  keyHint: "An OpenAI API key, starting with sk-. Create one at platform.openai.com, under API keys.",
  looksLikeKey: (s) => /^sk-[A-Za-z0-9_-]{20,}$/.test(s),
  async verify(key) {
    const res = await modelFetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return { ok: false, error: await errorText(res) };
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return { ok: true, models: body.data.map((m) => m.id).sort() };
  },
  async ask(key, model, input, opts) {
    const res = await modelFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, input,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const body = (await res.json()) as {
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("");
    return { text, inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null };
  },
};

export const PROVIDERS: Record<string, Provider> = { openai };

export function provider(id: string): Provider | null {
  return PROVIDERS[id] ?? null;
}
