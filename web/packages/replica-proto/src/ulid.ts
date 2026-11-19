// ULIDs: 26 Crockford base32 characters, a 48-bit millisecond time and 80
// random bits. Clients make the first id of a mutation and the mutation id;
// later ids of the same mutation are derived (`deriveId`), so a client and the
// server compute the same ids without a random source in `run`.

import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID whose time fits 48 bits (the first character is at most 7). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const MINUTE = 60_000;
export const DAY = 86_400_000;
/** The accepted age of a client-made ULID, measured on the device's clock
 * (the envelope's `clientTime`): at most 4 days old (the outbox keeps a write
 * 3 days; the extra day is a margin for retries near the end of the outbox's
 * lifetime) and at most 1 minute in the future. Since the device's clock is
 * itself at most `CLOCK_MAX_SKEW` from the server's, a stored id's time is
 * within 4 days and 2 minutes of the server's time when it is written. The
 * window is shorter than the 7 days idempotency is kept, so a mutation id is
 * EXPIRED before its stored result expires. */
export const ID_MAX_AGE = 4 * DAY;
export const ID_MAX_AHEAD = MINUTE;
/** The most a device's `clientTime` may differ from the server's time. */
export const CLOCK_MAX_SKEW = MINUTE;

export const isUlid = (s: string) => ULID_RE.test(s);

export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + B32.indexOf(id.charAt(i));
  return t;
}

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0, x = ms; i < 10; i++, x = Math.floor(x / 32)) out = B32.charAt(x % 32) + out;
  return out;
}

/** A new ULID at `ms` with randomness from `random` (a client's or the
 * server's source; never called from `run`). */
export function ulid(ms: number, random: () => number): string {
  let r = "";
  for (let i = 0; i < 16; i++) r += B32.charAt(Math.floor(random() * 32) % 32);
  return encodeTime(ms) + r;
}

/** Whether a client-made ULID's age on the device's clock is accepted: at
 * most `ID_MAX_AGE` old and at most `ID_MAX_AHEAD` in the future of
 * `deviceNow`. */
export function ageOk(id: string, deviceNow: number): boolean {
  const age = deviceNow - ulidTime(id);
  return age <= ID_MAX_AGE && age >= -ID_MAX_AHEAD;
}

/** A random number in [0, 1) from `crypto.randomBytes` (48 bits): the
 * server's default random source. */
export function cryptoRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** A 32-character hex digest of a string (cyrb128). It identifies a payload
 * for the replay check: the stored digest is compared only with the digest of
 * a later write by the same user under the same mutation id, so a collision
 * could only make a person's own conflicting replay answer their own stored
 * result. */
export function digest(str: string): string {
  return cyrb128(str)
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}

/** cyrb128: a 128-bit non-cryptographic string hash (public domain). */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** The id at `ordinal` (1, 2, …) of a mutation: the mutation id's time and 80
 * bits of a hash of (user, mutation id, ordinal).
 *
 * DESIGN (phase 0 finding): AGENTS.md derives later ids from the mutation id
 * and an ordinal. Idempotency is keyed by (user, mutation id), so two users
 * may send the same mutation id; without the user in the hash their derived
 * ids would collide and the second write would fail with CONFLICT, which is
 * the "another user's mutation id blocks your write" case. The user is part of
 * the derivation here.
 *
 * A fast non-cryptographic hash is enough. A derived id only has to differ
 * from other ids, and the store checks that: `tx.create` refuses an id that
 * was ever used (CONFLICT), so a collision can fail the writer's own mutation
 * but never overwrite or reveal a record. Aiming a collision at someone else
 * needs their next mutation id, whose 80 random bits are unknown until it is
 * sent; a person's own derived ids can collide only with ids that already
 * exist, which answers CONFLICT to that person alone. */
export function deriveId(user: string, mutationId: string, ordinal: number): string {
  const h = cyrb128(`${user}\u0000${mutationId}\u0000${ordinal}`);
  let n = (BigInt(h[0]) << 48n) | (BigInt(h[1]) << 16n) | BigInt(h[2] >>> 16);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = B32.charAt(Number(n & 31n)) + r;
    n >>= 5n;
  }
  return mutationId.slice(0, 10) + r;
}
