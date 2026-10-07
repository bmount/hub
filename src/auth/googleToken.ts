// Verification of Google OpenID Connect ID tokens.
//
// The token arrives from Google's token endpoint over TLS, which the OIDC spec allows to stand in for a
// signature check. We verify the signature anyway, against Google's published keys, so a token is never
// trusted on transport alone.

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string; // hosted domain: present only for Google Workspace accounts
  name?: string;
  nonce?: string;
}

export interface Jwk { kid: string; kty: string; alg?: string; n: string; e: string }

export type JwksSource = () => Promise<Jwk[]>;

export class TokenError extends Error {}

function b64urlBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  try { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }
  catch { throw new TokenError('malformed token'); }
}

// Google's keys rotate a few times a month; a per-isolate cache keeps the callback fast.
let cache: { keys: Jwk[]; until: number } | null = null;
export function googleJwks(fetcher: typeof fetch = fetch): JwksSource {
  return async () => {
    if (cache && cache.until > Date.now()) return cache.keys;
    const res = await fetcher(GOOGLE_JWKS_URL);
    if (!res.ok) throw new TokenError(`could not fetch Google keys (${res.status})`);
    const body = (await res.json()) as { keys: Jwk[] };
    cache = { keys: body.keys, until: Date.now() + 60 * 60 * 1000 };
    return body.keys;
  };
}

export async function verifyGoogleIdToken(
  token: string,
  opts: { clientId: string; nonce: string; keys: JwksSource; now?: number },
): Promise<GoogleClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token');
  const [h, p, sig] = parts as [string, string, string];
  const header = b64urlJson(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new TokenError('unexpected token algorithm');
  const jwk = (await opts.keys()).find(k => k.kid === header.kid);
  if (!jwk) throw new TokenError('token signed with an unknown key');
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new TokenError('bad token signature');

  const c = b64urlJson(p);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!GOOGLE_ISSUERS.includes(String(c.iss))) throw new TokenError('token not issued by Google');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) throw new TokenError('token not meant for this app');
  if (typeof c.exp !== 'number' || c.exp < now - 60) throw new TokenError('token expired');
  if (typeof c.iat === 'number' && c.iat > now + 300) throw new TokenError('token issued in the future');
  if (c.nonce !== opts.nonce) throw new TokenError('token nonce mismatch');
  if (typeof c.sub !== 'string' || typeof c.email !== 'string') throw new TokenError('token missing identity');
  // Google sends email_verified as a boolean; older tokens used the string "true".
  const verified = c.email_verified === true || c.email_verified === 'true';
  return {
    sub: c.sub, email: c.email.toLowerCase(), email_verified: verified,
    hd: typeof c.hd === 'string' ? c.hd.toLowerCase() : undefined,
    name: typeof c.name === 'string' ? c.name : undefined,
    nonce: c.nonce as string,
  };
}

// PKCE (RFC 7636) and random values for state and nonce.
export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
