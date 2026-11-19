// ULIDs: 26 Crockford base32 characters, a 48-bit millisecond time and 80
// random bits. A client makes a mutation's id and the first new id in its
// input; the mutation's later ids are derived from (user, mutation id,
// ordinal) by `deriveId`, so the client and the server compute the same ids
// without a random source in `run`.

import { DAY, MINUTE } from "./time.js";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID whose time fits 48 bits (the first character is at most 7). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const isUlid = (s: string) => ULID_RE.test(s);

/** The accepted age of a client-made ULID on the device's clock: at most 4
 * days old (the outbox keeps a write 3 days, plus a day of margin) and at
 * most a minute in the future (AGENTS.md, "Ids"). */
export const ID_MAX_AGE = 4 * DAY;
export const ID_MAX_AHEAD = MINUTE;
/** The most an online-only write's mutation id may be behind the device's
 * time: older, it waited in an outbox. */
export const ONLINE_MAX_AGE = MINUTE;

export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + B32.indexOf(id.charAt(i));
  return t;
}

/** Whether a client-made ULID's age on the device's clock (`deviceNow`) is
 * accepted. */
export function ageOk(id: string, deviceNow: number): boolean {
  const age = deviceNow - ulidTime(id);
  return age <= ID_MAX_AGE && age >= -ID_MAX_AHEAD;
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
 * bits of a hash of (user, mutation id, ordinal). The user is part of the
 * hash because idempotency is keyed by (user, mutation id): two users may
 * send the same mutation id, and their derived ids must not collide. A fast
 * non-cryptographic hash is enough: a new record's id is checked against
 * every id ever used (CONFLICT), so a collision can fail the writer's own
 * mutation but never overwrite or reveal a record. Identical to replica-proto's
 * `deriveId`. */
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
