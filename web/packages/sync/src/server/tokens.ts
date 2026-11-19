// Cursor tokens: AES-256-GCM under a configured key (AGENTS.md: the key is
// configured, not per process; the previous key is accepted for 30 days
// after a rotation). A token holds the log, the reader, the log's history,
// the internal version the reader is at, the server's head, the time it
// was served and the database instance that served it; nothing of it reads
// without the key, and its length depends only on the lengths of the log id
// and the handle.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { TOMBSTONE_TTL, type Cursor } from "../protocol.js";

export interface CursorState {
  log: string;
  u: string | null;
  /** The log's history (`Epoch.n`). */
  n: number;
  /** The newest row of the log the reader was given, or 0. */
  v: number;
  /** The server's head when it was served. */
  h: number;
  /** When it was served (server time). */
  at: number;
  /** The database instance that served it (review round 1 of phase 1,
   * E22): a token from another one answers resync. */
  i: number;
}

/** The token keys: 32 bytes each. A rotation makes the current key the
 * previous one, with the time of the rotation. */
export interface CursorKeys {
  current: Uint8Array;
  previous?: { key: Uint8Array; rotatedAt: number };
}

/** How long a key is accepted after it was rotated out. */
export const KEY_GRACE = TOMBSTONE_TTL;

const FORMAT = 2;
const HEAD = 37;
const IV = 12;
const TAG = 16;
const MAX_LENGTH = 1024;

/** A new random key (for tests, and to make the configured one). */
export const newCursorKey = (): Uint8Array => randomBytes(32);

export class Tokens {
  constructor(private readonly keys: CursorKeys) {
    if (keys.current.length !== 32) throw new Error("a cursor key is 32 bytes");
  }

  seal(c: CursorState): Cursor {
    const head = Buffer.alloc(HEAD);
    head.writeUInt8(FORMAT, 0);
    head.writeUInt32BE(c.n, 1);
    head.writeDoubleBE(c.v, 5);
    head.writeDoubleBE(c.h, 13);
    head.writeDoubleBE(c.at, 21);
    head.writeDoubleBE(c.i, 29);
    const plain = Buffer.concat([head, Buffer.from(JSON.stringify([c.log, c.u]), "utf8")]);
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", this.keys.current, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  /** The state a token holds, or null: not sealed by a key accepted at `now`,
   * changed, or malformed. */
  open(token: unknown, now: number): CursorState | null {
    if (typeof token !== "string" || token.length > MAX_LENGTH) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < IV + HEAD + TAG) return null;
    const keys = [this.keys.current];
    const prev = this.keys.previous;
    if (prev && now - prev.rotatedAt <= KEY_GRACE) keys.push(prev.key);
    for (const key of keys) {
      let plain: Buffer;
      try {
        const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
        d.setAuthTag(raw.subarray(raw.length - TAG));
        plain = Buffer.concat([d.update(raw.subarray(IV, raw.length - TAG)), d.final()]);
      } catch {
        continue;
      }
      if (plain.readUInt8(0) !== FORMAT) return null;
      try {
        const [log, u] = JSON.parse(plain.subarray(HEAD).toString("utf8")) as [
          string,
          string | null,
        ];
        return {
          log,
          u,
          n: plain.readUInt32BE(1),
          v: plain.readDoubleBE(5),
          h: plain.readDoubleBE(13),
          at: plain.readDoubleBE(21),
          i: plain.readDoubleBE(29),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}
