// ULIDs on the prototype's server and client: new ids from a random source
// (never from `run`), the age window of a client-made id, and the server's
// random source and payload digest. The ULID form, `ulidTime` and the
// derived ids `run` uses (`deriveId`) are `@session/mutators`'.

import { randomBytes } from "node:crypto";

import { DAY, MINUTE, hash128, ulidTime } from "@session/mutators";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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
  return timeOk(ulidTime(id), deviceNow);
}

/** Whether a time on the device's clock (an envelope's `queuedAt`, a
 * ULID's time) is in the same window: at most `ID_MAX_AGE` before
 * `deviceNow` and at most `ID_MAX_AHEAD` after it. */
export function timeOk(ms: number, deviceNow: number): boolean {
  const age = deviceNow - ms;
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
  return hash128(str)
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}
