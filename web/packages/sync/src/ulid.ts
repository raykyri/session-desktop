// ULIDs on both halves: new ids from a random source (never from a
// mutator's `run`), the age window of a client-made id, the payload digest
// and the canonical JSON it is computed over. The ULID form, `ulidTime` and
// the derived ids `run` uses (`deriveId`) are `@session/mutators`'.

import { DAY, MINUTE, hash128, ulidTime } from "@session/mutators";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The accepted age of a client-made ULID, measured on the device's clock
 * (the envelope's `clientTime`): at most 4 days old and at most 1 minute in
 * the future. The window is shorter than the 7 days answers are kept, so a
 * mutation id is EXPIRED before its stored answer expires. */
export const ID_MAX_AGE = 4 * DAY;
export const ID_MAX_AHEAD = MINUTE;
/** The most a device's `clientTime` may differ from the server's time. */
export const CLOCK_MAX_SKEW = MINUTE;

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0, x = ms; i < 10; i++, x = Math.floor(x / 32)) out = B32.charAt(x % 32) + out;
  return out;
}

/** A new ULID at `ms` with randomness from `random`, a number in [0, 1). */
export function ulid(ms: number, random: () => number): string {
  let r = "";
  for (let i = 0; i < 16; i++) r += B32.charAt(Math.floor(random() * 32) % 32);
  return encodeTime(ms) + r;
}

/** Whether a client-made ULID's age on the device's clock is accepted. */
export function ageOk(id: string, deviceNow: number): boolean {
  return timeOk(ulidTime(id), deviceNow);
}

/** Whether a time on the device's clock (an envelope's `queuedAt`, a ULID's
 * time) is at most `ID_MAX_AGE` before `deviceNow` and at most
 * `ID_MAX_AHEAD` after it. */
export function timeOk(ms: number, deviceNow: number): boolean {
  const age = deviceNow - ms;
  return age <= ID_MAX_AGE && age >= -ID_MAX_AHEAD;
}

/** A random number in [0, 1) from the Web Crypto API (48 bits), available in
 * browsers and in Node. */
export function webRandom(): number {
  const b = new Uint32Array(2);
  globalThis.crypto.getRandomValues(b);
  return ((b[0] ?? 0) * 2 ** 16 + ((b[1] ?? 0) >>> 16)) / 2 ** 48;
}

/** JSON with object keys sorted, so equal values print equally. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** A 32-character hex digest of a string (cyrb128). It identifies a payload
 * for the replay check: a stored digest is compared only with the digest of
 * a later write by the same user under the same mutation id. */
export function digest(str: string): string {
  return hash128(str)
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}
