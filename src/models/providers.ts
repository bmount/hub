// Model providers: how to check a key, list models, and ask a question (admin spec 10).
// Outbound calls go through `modelFetch`, so tests can stand in for the provider.

import { modelCall } from "./deadline";

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
  verify: (key: string, opts?: { signal?: AbortSignal }) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
  ask: (key: string, model: string, input: string, opts: { instructions?: string; maxOutputTokens?: number; signal?: AbortSignal }) => Promise<AskResult>;
  /** One step of a tool-using conversation: the model either answers or asks for function calls. Nothing is stored at the provider. */
  turn: (key: string, model: string, items: TurnItem[], opts: { instructions: string; tools: FunctionTool[]; maxOutputTokens?: number; signal?: AbortSignal }) => Promise<TurnResult>;
  /** Speech to text. `prompt` carries the vocabulary and conversation that make names come out right. */
  transcribe?: (key: string, model: string, audio: Blob, filename: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<AskResult>;
}

function errorText(res: Response, decoded: unknown): string {
  const body = decoded as { error?: { message?: string } } | null;
  return `${res.status}: ${body?.error?.message ?? res.statusText}`.slice(0, 300);
}

export const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readModelJSON(res: Response, signal: AbortSignal, check: () => void): Promise<unknown> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_MODEL_RESPONSE_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new Error("model response exceeds byte limit");
  }
  if (!res.body) return JSON.parse("");
  const reader = res.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = new Uint8Array(8192), size = 0;
  try {
    for (;;) {
      check();
      const { value, done } = await reader.read();
      check();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid model response stream");
      const next = size + value.byteLength;
      if (next > MAX_MODEL_RESPONSE_BYTES) throw new Error("model response exceeds byte limit");
      if (next > bytes.length) {
        const grown = new Uint8Array(Math.min(MAX_MODEL_RESPONSE_BYTES, Math.max(next, bytes.length * 2)));
        grown.set(bytes.subarray(0, size)); bytes = grown;
      }
      bytes.set(value, size); size = next;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)));
    check();
    return body;
  } catch (e) { cancel(); throw e; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

async function modelJSON(url: string, init: RequestInit, parent?: AbortSignal): Promise<{ res: Response; decoded: unknown }> {
  return modelCall(async (signal, check) => {
    let res: Response | undefined;
    const cancelBody = () => { if (res?.body) void res.body.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancelBody, { once: true });
    try {
      res = await modelFetch(url, { ...init, signal });
      check();
      let decoded: unknown;
      try { decoded = await readModelJSON(res, signal, check); }
      catch (e) { check(); if (res.ok) throw e; decoded = null; }
      check();
      return { res, decoded };
    } finally {
      // Never wait for cleanup, including transport that returns headers only
      // after the independent timeout race has already rejected.
      signal.removeEventListener("abort", cancelBody);
      if (signal.aborted) cancelBody();
    }
  }, parent);
}

const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  keyHint: "An OpenAI API key, starting with sk-. Create one at platform.openai.com, under API keys.",
  looksLikeKey: (s) => /^sk-[A-Za-z0-9_-]{20,}$/.test(s),
  async verify(key, opts) {
    const { res, decoded } = await modelJSON("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } }, opts?.signal);
    if (!res.ok) return { ok: false, error: errorText(res, decoded) };
    const body = decoded as { data: Array<{ id: string }> };
    return { ok: true, models: body.data.map((m) => m.id).sort() };
  },
  async ask(key, model, input, opts) {
    const { res, decoded } = await modelJSON("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, input,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
      }),
    }, opts.signal);
    if (!res.ok) throw new Error(errorText(res, decoded));
    const body = decoded as {
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
    const { res, decoded } = await modelJSON("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, input: items, instructions: opts.instructions, store: false,
        tools: opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
      }),
    }, opts.signal);
    if (!res.ok) throw new Error(errorText(res, decoded));
    const body = decoded as {
      output?: Array<Record<string, unknown> & { type: string; content?: Array<{ type: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    };
    const output = body.output ?? [];
    const text = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text" && typeof c.text === "string").map((c) => c.text!).join("");
    const calls = output.filter((o) => o.type === "function_call" && typeof o.call_id === "string" && typeof o.name === "string")
      .map((o) => ({ call_id: o.call_id!, name: o.name!, arguments: typeof o.arguments === "string" ? o.arguments : "{}" }));
    return { text, calls, output, inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null, cachedTokens: body.usage?.input_tokens_details?.cached_tokens ?? null };
  },
  async transcribe(key, model, audio, filename, prompt, opts) {
    const form = new FormData();
    form.set("file", audio, filename);
    form.set("model", model);
    form.set("response_format", "json");
    form.set("temperature", "0");
    if (prompt) form.set("prompt", prompt);
    const { res, decoded } = await modelJSON("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form }, opts?.signal);
    if (!res.ok) throw new Error(errorText(res, decoded));
    const body = decoded as { text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (body.text ?? "").trim(), inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null };
  },
};

export const PROVIDERS: Record<string, Provider> = { openai };

export function provider(id: string): Provider | null {
  return PROVIDERS[id] ?? null;
}
