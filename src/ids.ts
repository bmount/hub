const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Monotonic state, per isolate: last timestamp and its 16 base-32 random digits.
let lastTime = -1;
let lastRand: number[] = [];

function freshRand(): number[] {
  const rand = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(rand, (b) => b % 32);
}

// Increments the base-32 digits in place (with carry); returns false on overflow.
function incrementRand(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]!++;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Mints a 26-char Crockford base32 ULID. Ids are strictly increasing per isolate
 * for non-decreasing `now`: within the same millisecond the random part of the
 * previous id is incremented instead of redrawn (on random-part overflow the
 * timestamp advances by 1 ms). An explicit `now` earlier than the last one used
 * returns a valid id for that time with fresh random bits and does not touch the
 * monotonic state, so ordering is not guaranteed for such out-of-order calls.
 */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let rand: number[];
  if (t < lastTime) {
    rand = freshRand();
  } else {
    if (t === lastTime) {
      rand = lastRand.slice();
      if (!incrementRand(rand)) {
        t = lastTime + 1;
        rand = freshRand();
      }
    } else {
      rand = freshRand();
    }
    lastTime = t;
    lastRand = rand;
  }
  const out: string[] = new Array(26);
  for (let i = 9; i >= 0; i--) {
    out[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out[10 + i] = CROCKFORD[rand[i]!]!;
  return out.join("");
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}
