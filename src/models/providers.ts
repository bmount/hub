// Model providers: how to check a key, list models, and ask a question (admin spec 10).
// Outbound calls go through `modelFetch`, so tests can stand in for the provider.

let modelFetch: typeof fetch = (input, init) => fetch(input, init);
export function setModelFetchForTest(f: typeof fetch | null): void {
  modelFetch = f ?? ((input, init) => fetch(input, init));
}

export type AskResult = { text: string; inputTokens: number | null; outputTokens: number | null };

/** A conversation item in the provider's own shape; kept opaque so each turn can hand back exactly what it received. */
export type TurnItem = Record<string, unknown>;
export type FunctionTool = { name: string; description: string; parameters: Record<string, unknown> };
export type TurnResult = {
  text: string; calls: Array<{ call_id: string; name: string; arguments: string }>; output: TurnItem[];
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
};

export interface Provider {
  id: string;
  name: string;
  /** Plain-language hint shown where a key is pasted. */
  keyHint: string;
  looksLikeKey: (s: string) => boolean;
  /** Ok and the model ids the key can use, or the provider's error. */
  verify: (key: string) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
  ask: (key: string, model: string, input: string, opts: { instructions?: string; maxOutputTokens?: number }) => Promise<AskResult>;
  /** One step of a tool-using conversation: the model either answers or asks for function calls. Nothing is stored at the provider. */
  turn: (key: string, model: string, items: TurnItem[], opts: { instructions: string; tools: FunctionTool[]; maxOutputTokens?: number }) => Promise<TurnResult>;
  /** Speech to text. `prompt` carries the vocabulary and conversation that make names come out right. */
  transcribe?: (key: string, model: string, audio: Blob, filename: string, prompt: string) => Promise<AskResult>;
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
  async turn(key, model, items, opts) {
    const res = await modelFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, input: items, instructions: opts.instructions, store: false,
        tools: opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const body = (await res.json()) as {
      output?: Array<Record<string, unknown> & { type: string; content?: Array<{ type: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    };
    const output = body.output ?? [];
    const text = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text" && typeof c.text === "string").map((c) => c.text!).join("");
    const calls = output.filter((o) => o.type === "function_call" && typeof o.call_id === "string" && typeof o.name === "string")
      .map((o) => ({ call_id: o.call_id!, name: o.name!, arguments: typeof o.arguments === "string" ? o.arguments : "{}" }));
    return { text, calls, output, inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null, cachedTokens: body.usage?.input_tokens_details?.cached_tokens ?? null };
  },
  async transcribe(key, model, audio, filename, prompt) {
    const form = new FormData();
    form.set("file", audio, filename);
    form.set("model", model);
    form.set("response_format", "json");
    form.set("temperature", "0");
    if (prompt) form.set("prompt", prompt);
    const res = await modelFetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) throw new Error(await errorText(res));
    const body = (await res.json()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (body.text ?? "").trim(), inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null };
  },
};

export const PROVIDERS: Record<string, Provider> = { openai };

export function provider(id: string): Provider | null {
  return PROVIDERS[id] ?? null;
}
