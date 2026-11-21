// The event id of a `changes` or `resync` event on the sync stream (`01`
// Y7): the map `{ log: cursorToken }` of every log the stream reads, with the
// reader's handle and the database's history id (`ServerStore.history`),
// sealed with AES-256-GCM under the cursor key and the additional data
// `EVENT_ID_AAD`, so a reconnect with `Last-Event-ID` resumes every log and
// the client learns nothing from the id itself. The tokens inside are sealed
// already; the map is sealed too so that the set of logs and their order are
// not readable either. The additional data differs from a cursor token's
// (`sync/src/server/tokens.ts`), so neither opens as the other.
//
// An id opens only for the reader it was sealed for: another person's id,
// or a signed-in person's id sent by someone else, opens as nothing. An id
// sealed under another history (before a restore) opens with its logs and
// no cursors, so each of them resyncs. The previous cursor key opens ids for
// 30 days after a rotation, as it opens tokens.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { LogId } from "@session/mutators";
import { PREVIOUS_KEY_TTL, type CursorKeys } from "@session/sync/server";

const IV = 12;
const TAG = 16;
/** The additional data of every event id. */
const EVENT_ID_AAD = Buffer.from("session/event-id/2", "utf8");
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

/** Who an id is sealed for, and under which history. */
export interface EventIdScope {
  u: string;
  history: string;
}

export class EventIds {
  readonly #keys: CursorKeys;
  readonly #now: () => number;

  constructor(keys: CursorKeys, now: () => number) {
    this.#keys = keys;
    this.#now = now;
  }

  seal(map: CursorMap, scope: EventIdScope): string {
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", this.#keys.current, iv);
    cipher.setAAD(EVENT_ID_AAD);
    const plain = JSON.stringify({ u: scope.u, h: scope.history, c: Object.fromEntries(map) });
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The cursors of an id sealed for `scope.u`, or null: not an id this
   * server sealed, or sealed for another reader. Under another history the
   * logs come back with empty cursors, which resync. */
  open(id: string, scope: EventIdScope): CursorMap | null {
    if (id.length > MAX_EVENT_ID) return null;
    const raw = Buffer.from(id, "base64url");
    if (raw.length <= IV + TAG) return null;
    const keys = [this.#keys.current];
    const previous = this.#keys.previous;
    if (previous && this.#now() < previous.rotatedAt + PREVIOUS_KEY_TTL) keys.push(previous.key);
    for (const key of keys) {
      let text: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
        decipher.setAAD(EVENT_ID_AAD);
        decipher.setAuthTag(raw.subarray(IV, IV + TAG));
        text = Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]);
      } catch {
        // another key, or not an id this server sealed
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.toString("utf8"));
      } catch {
        return null;
      }
      const { u, h, c } = (parsed ?? {}) as { u?: unknown; h?: unknown; c?: unknown };
      if (u !== scope.u || typeof h !== "string") return null;
      const map = cursorMapFrom(c);
      if (!map) return null;
      if (h !== scope.history) for (const log of map.keys()) map.set(log, "");
      return map;
    }
    return null;
  }
}
