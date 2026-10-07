// AES-GCM sealing for provider keys at rest (admin spec 10.2). The key is the Worker secret HUB_SECRETS_KEY:
// 32 random bytes, base64. Without it, D1's ciphertext is useless.

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SecretsKeyMissing extends Error {
  constructor() { super("HUB_SECRETS_KEY is not set"); }
}

async function key(secretsKey: string | undefined): Promise<CryptoKey> {
  if (!secretsKey) throw new SecretsKeyMissing();
  const raw = unb64(secretsKey);
  if (raw.length !== 32) throw new Error("HUB_SECRETS_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secretsKey: string | undefined, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secretsKey), new TextEncoder().encode(plaintext)));
  return { ciphertext: b64(ct), iv: b64(iv) };
}

export async function open(secretsKey: string | undefined, sealed: { ciphertext: string; iv: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, await key(secretsKey), unb64(sealed.ciphertext));
  return new TextDecoder().decode(pt);
}

/** What a person may see of a key: the provider's prefix and the last four characters. */
export function fingerprint(secret: string): string {
  const prefix = secret.match(/^[a-z]+-(?:[a-z]+-)?/)?.[0] ?? "";
  return `${prefix}…${secret.slice(-4)}`;
}
