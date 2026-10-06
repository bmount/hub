import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { randomToken } from "../ids";
import { PENDING_TTL_S } from "./config";

/** A parsed authorization request waiting for consent (MCP spec 7.2 step 2). Lives in OAUTH_KV for 30 minutes. */
export type Pending = {
  id: string;
  created_at: number;
  request: AuthRequest;
  client_id: string;
  client_name: string;
  redirect_host: string;
  redirect_label: string;
  loopback: boolean;
  tenant_slug: string;
  scopes: string[];
  /** The first browser session that viewed the consent page; nobody else may decide (MCP spec 7.3). */
  session_id: string | null;
  /** Random per-request form token, issued with the binding and required on the decision POST. */
  form_token: string | null;
};

export const PENDING_ID = /^[A-Za-z0-9_-]{43}$/;
const key = (id: string) => `pending:${id}`;

async function save(env: Env, p: Pending, now: number): Promise<boolean> {
  const expiration = Math.floor(p.created_at / 1000) + PENDING_TTL_S;
  if (expiration - Math.floor(now / 1000) < 60) return false; // KV refuses expirations under a minute away
  await env.OAUTH_KV.put(key(p.id), JSON.stringify(p), { expiration });
  return true;
}

export async function createPending(
  env: Env, input: Omit<Pending, "id" | "created_at" | "session_id" | "form_token">, now: number,
): Promise<Pending> {
  const p: Pending = { ...input, id: randomToken(""), created_at: now, session_id: null, form_token: null };
  await save(env, p, now);
  return p;
}

export async function loadPending(env: Env, id: string, now: number): Promise<Pending | null> {
  if (!PENDING_ID.test(id)) return null;
  const p = await env.OAUTH_KV.get<Pending>(key(id), "json");
  if (!p || now - p.created_at > PENDING_TTL_S * 1000) return null;
  return p;
}

/** Bind to the first viewing session and issue the form token; any other session gets null. */
export async function bindPending(env: Env, p: Pending, session_id: string, now: number): Promise<Pending | null> {
  if (p.session_id === session_id && p.form_token) return p;
  if (p.session_id !== null) return null;
  const bound: Pending = { ...p, session_id, form_token: randomToken("") };
  return (await save(env, bound, now)) ? bound : null;
}

export async function deletePending(env: Env, id: string): Promise<void> {
  await env.OAUTH_KV.delete(key(id));
}
