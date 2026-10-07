import { describe, it, expect, beforeAll } from 'vitest';
import { verifyGoogleIdToken, pkceChallenge, TokenError, type Jwk } from '../src/auth/googleToken';

const CLIENT = 'client-123.apps.googleusercontent.com';
let priv: CryptoKey;
let jwk: Jwk;
let otherPriv: CryptoKey;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(claims: Record<string, unknown>, key = priv, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const h = b64url(JSON.stringify(header)), p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
const good = () => ({
  iss: 'https://accounts.google.com', aud: CLIENT, sub: '1001', email: 'Pat@Example.com',
  email_verified: true, hd: 'example.com', name: 'Pat', nonce: 'n1', iat: now, exp: now + 3600,
});
const keys = async () => [jwk];

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  const kp = await gen();
  priv = kp.privateKey;
  const pub = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  jwk = { kid: 'k1', kty: 'RSA', alg: 'RS256', n: pub.n!, e: pub.e! };
  otherPriv = (await gen()).privateKey;
});

describe('verifyGoogleIdToken', () => {
  it('accepts a well-formed token and normalizes the email and domain', async () => {
    const c = await verifyGoogleIdToken(await sign(good()), { clientId: CLIENT, nonce: 'n1', keys });
    expect(c).toMatchObject({ sub: '1001', email: 'pat@example.com', email_verified: true, hd: 'example.com', name: 'Pat' });
  });

  it('accepts the bare issuer form Google also uses', async () => {
    const c = await verifyGoogleIdToken(await sign({ ...good(), iss: 'accounts.google.com' }), { clientId: CLIENT, nonce: 'n1', keys });
    expect(c.sub).toBe('1001');
  });

  it('reports an unverified email as unverified rather than failing', async () => {
    const c = await verifyGoogleIdToken(await sign({ ...good(), email_verified: false }), { clientId: CLIENT, nonce: 'n1', keys });
    expect(c.email_verified).toBe(false);
  });

  const bad: [string, () => Promise<string>, string?][] = [
    ['signed by another key', () => sign(good(), otherPriv)],
    ['wrong audience', () => sign({ ...good(), aud: 'someone-else' })],
    ['wrong issuer', () => sign({ ...good(), iss: 'https://evil.example' })],
    ['expired', () => sign({ ...good(), exp: now - 3600 })],
    ['nonce mismatch', () => sign({ ...good(), nonce: 'other' })],
    ['unknown key id', () => sign(good(), priv, { alg: 'RS256', kid: 'nope' })],
    ['alg none', () => sign(good(), priv, { alg: 'none', kid: 'k1' })],
  ];
  for (const [name, make] of bad) {
    it(`rejects a token ${name}`, async () => {
      await expect(verifyGoogleIdToken(await make(), { clientId: CLIENT, nonce: 'n1', keys })).rejects.toBeInstanceOf(TokenError);
    });
  }

  it('rejects a tampered payload', async () => {
    const t = await sign(good());
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...good(), email: 'boss@example.com' }))}.${s}`;
    await expect(verifyGoogleIdToken(forged, { clientId: CLIENT, nonce: 'n1', keys })).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects garbage', async () => {
    await expect(verifyGoogleIdToken('not.a.jwt', { clientId: CLIENT, nonce: 'n1', keys })).rejects.toBeInstanceOf(TokenError);
  });
});

describe('pkceChallenge', () => {
  it('is the base64url SHA-256 of the verifier (value cross-checked with node crypto)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU2p1r_wW-gXFWEjk-M')).toBe('_Ttao4D0LR0Kg_nGCIgrB31uNX2-e6XNXQ9qlgidPBo');
  });
});
