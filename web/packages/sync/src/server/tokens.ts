// Cursor tokens (`01` Y6): AES-256-GCM, a new random IV for each, over a
// fixed 45-byte head (format, the log's epoch, version, head, serve time,
// the database's history id) and the JSON of [log, reader], so a token's
// length depends only on the lengths of the log id and the reader's handle.
// The tag authenticates every field and the additional data `TOKEN_AAD`; a
// token from another key, an event id (`server/src/sync/eventIds.ts`, other
// additional data), or a token with any byte changed, does not open.
//
// The key is configured (`SESSION_CURSOR_KEY`), not made per process; after
// a rotation the previous key (`SESSION_CURSOR_KEY_PREVIOUS`) still opens
// tokens for 30 days, then a token sealed with it resyncs.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DAY } from "@session/mutators";

import type { Cursor } from "../wire.js";

/** What a cursor token holds. `v`: the version of the newest row of the log
 * the reader was given, or 0. `h`: the server's head when it was served.
 * `n`: the log's epoch (`replaceHistory`). `at`: when it was served. `hid`:
 * the database's history id (`ServerStore.history`, 32 hex digits), which a
 * detected restore replaces (`01` D6). */
export interface CursorState {
  log: string;
  u: string | null;
  n: number;
  v: number;
  h: number;
  at: number;
  hid: string;
}

/** The keys that seal and open cursor tokens: 32 bytes each. `previous` is
 * accepted until `rotatedAt` + 30 days. */
export interface CursorKeys {
  current: Uint8Array;
  previous?: { key: Uint8Array; rotatedAt: number };
}

/** How long a previous key still opens tokens after a rotation. */
export const PREVIOUS_KEY_TTL = 30 * DAY;

const TOKEN_FORMAT = 2;
const TOKEN_HEAD = 45;
/** Bytes of the history id. */
export const HISTORY_ID_BYTES = 16;
/** The additional data every cursor token is sealed with: a sealed value of
 * another kind under the same key does not open as a token. */
const TOKEN_AAD = Buffer.from("session/cursor-token/2", "utf8");
const HISTORY_RE = /^[0-9a-f]{32}$/;
const TOKEN_IV = 12;
const TOKEN_TAG = 16;
const TOKEN_MAX_LENGTH = 1024;

/** A cursor key from its configured form: 32 bytes of base64 (`01` S3). */
export function cursorKeyFrom(base64: string): Uint8Array {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("a cursor key is 32 bytes of base64");
  return key;
}

export class Tokens {
  private readonly key: Uint8Array;
  private readonly previous: CursorKeys["previous"];

  /** Without keys, a random key of this process (tests only: a restart then
   * resyncs every reader). */
  constructor(keys?: CursorKeys) {
    for (const k of [keys?.current, keys?.previous?.key])
      if (k && k.length !== 32) throw new Error("a cursor key is 32 bytes");
    this.key = keys?.current ?? randomBytes(32);
    this.previous = keys?.previous;
  }

  seal(c: CursorState): Cursor {
    const head = Buffer.alloc(TOKEN_HEAD);
    head.writeUInt8(TOKEN_FORMAT, 0);
    head.writeUInt32BE(c.n, 1);
    head.writeDoubleBE(c.v, 5);
    head.writeDoubleBE(c.h, 13);
    head.writeDoubleBE(c.at, 21);
    if (!HISTORY_RE.test(c.hid)) throw new Error("a history id is 32 hex digits");
    head.write(c.hid, 29, HISTORY_ID_BYTES, "hex");
    const plain = Buffer.concat([head, Buffer.from(JSON.stringify([c.log, c.u]), "utf8")]);
    const iv = randomBytes(TOKEN_IV);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(TOKEN_AAD);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  /** The token's state, or null: not a token, or sealed with neither key (the
   * previous one only within 30 days of the rotation, by `now`). */
  open(token: unknown, now: number): CursorState | null {
    const keys = [this.key];
    if (this.previous && now < this.previous.rotatedAt + PREVIOUS_KEY_TTL)
      keys.push(this.previous.key);
    for (const key of keys) {
      const c = this.openWith(key, token);
      if (c) return c;
    }
    return null;
  }

  private openWith(key: Uint8Array, token: unknown): CursorState | null {
    if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < TOKEN_IV + TOKEN_HEAD + TOKEN_TAG) return null;
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, TOKEN_IV));
      decipher.setAAD(TOKEN_AAD);
      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));
      plain = Buffer.concat([
        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),
        decipher.final(),
      ]);
    } catch {
      return null;
    }
    if (plain.readUInt8(0) !== TOKEN_FORMAT) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain.subarray(TOKEN_HEAD).toString("utf8"));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [log, u] = parsed as [unknown, unknown];
    if (typeof log !== "string" || (u !== null && typeof u !== "string")) return null;
    return {
      log,
      u,
      n: plain.readUInt32BE(1),
      v: plain.readDoubleBE(5),
      h: plain.readDoubleBE(13),
      at: plain.readDoubleBE(21),
      hid: plain.toString("hex", 29, TOKEN_HEAD),
    };
  }
}
