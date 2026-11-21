// The event id of a `changes` event on the sync stream (`01` Y7): the map
// `{ log: cursorToken }` of every log the stream reads, sealed with
// AES-256-GCM under the cursor key, so a reconnect with `Last-Event-ID`
// resumes every log and the client learns nothing from the id itself. The
// tokens inside are sealed already; the map is sealed too so that the set of
// logs and their order are not readable either. The previous cursor key opens
// ids for 30 days after a rotation, as it opens tokens.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { LogId } from "@session/mutators";
import { PREVIOUS_KEY_TTL, type CursorKeys } from "@session/sync/server";

const IV = 12;
const TAG = 16;
/** The largest id a client may send back. */
export const MAX_EVENT_ID = 64 * 1024;
/** The most logs one stream reads. */
export const MAX_STREAM_LOGS = 64;

export type CursorMap = Map<LogId, string>;

const LOG = /^(space|user):[^:]{1,190}$/;

/** A map of log ids to cursors, from JSON a client sent, or null. */
export function cursorMapFrom(value: unknown): CursorMap | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: CursorMap = new Map();
  for (const [log, cursor] of Object.entries(value)) {
    if (!LOG.test(log) || typeof cursor !== "string" || cursor.length > 1024) return null;
    out.set(log as LogId, cursor);
  }
  return out.size <= MAX_STREAM_LOGS ? out : null;
}

export class EventIds {
  readonly #keys: CursorKeys;
  readonly #now: () => number;

  constructor(keys: CursorKeys, now: () => number) {
    this.#keys = keys;
    this.#now = now;
  }

  seal(map: CursorMap): string {
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", this.#keys.current, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(Object.fromEntries(map)), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  open(id: string): CursorMap | null {
    if (id.length > MAX_EVENT_ID) return null;
    const raw = Buffer.from(id, "base64url");
    if (raw.length <= IV + TAG) return null;
    const keys = [this.#keys.current];
    const previous = this.#keys.previous;
    if (previous && this.#now() < previous.rotatedAt + PREVIOUS_KEY_TTL) keys.push(previous.key);
    for (const key of keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
        decipher.setAuthTag(raw.subarray(IV, IV + TAG));
        const text = Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]);
        return cursorMapFrom(JSON.parse(text.toString("utf8")));
      } catch {
        // another key, or not an id this server sealed
      }
    }
    return null;
  }
}
