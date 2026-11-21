// Client-made ULIDs (`AGENTS.md`, "Ids"): a 48-bit millisecond time and 80
// random bits, Crockford base32. Mutation ids and the first id of a write
// are made here; later ids of the same write derive from the mutation id
// (`@session/mutators` `deriveId`).

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += B32.charAt(byte & 31);
  return out;
}

/** The 10 time characters of a ULID for `ms`. */
export function ulidTimePart(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = B32.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** A new ULID at `ms` (default: now). */
export function newUlid(ms: number = Date.now()): string {
  return ulidTimePart(ms) + randomChars(16);
}
