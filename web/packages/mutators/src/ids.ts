// ULIDs: 26 Crockford base32 characters, a 48-bit millisecond time and 80
// random bits. Clients make the first id of a mutation and the mutation id;
// later ids of the same mutation are derived (`deriveId`), so a client and
// the server compute the same ids without a random source in `run`.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID whose time fits 48 bits (the first character is at most 7). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const MINUTE = 60_000;
export const DAY = 86_400_000;

export const isUlid = (s: string) => ULID_RE.test(s);

/** The time of a ULID, in milliseconds since the epoch. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + B32.indexOf(id.charAt(i));
  return t;
}

/** cyrb128: a 128-bit non-cryptographic string hash (public domain). */
export function hash128(str: string): [number, number, number, number] {
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
 * bits of a hash of (user, mutation id, ordinal). `run` takes its later ids
 * from `tx.id(ordinal)`, which is this; `notify` from ordinals above 1000.
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
  const h = hash128(`${user}\u0000${mutationId}\u0000${ordinal}`);
  let n = (BigInt(h[0]) << 48n) | (BigInt(h[1]) << 16n) | BigInt(h[2] >>> 16);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = B32.charAt(Number(n & 31n)) + r;
    n >>= 5n;
  }
  return mutationId.slice(0, 10) + r;
}
