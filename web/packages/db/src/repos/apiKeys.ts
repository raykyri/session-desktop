// API keys at rest (phase 2a): the raw key encrypted with AES-256-GCM under
// the configured key-encryption key, and an HMAC-SHA256 fingerprint under the
// same key for finding a duplicate. The `apikey` record a client reads is
// `@session/sync`'s; `KeyCipher` is what the server builds from its
// configuration.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { apiKeys } from "../schema/apiKeys.js";
import { now } from "../time.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Encryption of raw keys under one 32-byte key. */
export class KeyCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("the API key encryption key must be 32 bytes");
  }

  seal(raw: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(raw, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
  }

  open(sealed: string): string {
    const b = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }

  fingerprint(u: string, raw: string): string {
    return createHmac("sha256", this.key).update(`${u}\n${raw}`).digest("base64url");
  }
}

export function findByRaw(
  db: SessionDatabase,
  cipher: KeyCipher,
  userId: string,
  handle: string,
  raw: string,
): string | null {
  const row = db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.userId, userId), eq(apiKeys.fingerprint, cipher.fingerprint(handle, raw))),
    )
    .get();
  return row?.id ?? null;
}

/** Store (or replace) the raw value of key `id`. */
export function put(
  db: SessionDatabase,
  cipher: KeyCipher,
  input: {
    id: string;
    userId: string;
    handle: string;
    raw: string;
    mask: string;
    provider: string;
    at?: number;
  },
): void {
  const at = input.at ?? now();
  const values = {
    rawEnc: cipher.seal(input.raw),
    fingerprint: cipher.fingerprint(input.handle, input.raw),
    mask: input.mask,
    provider: input.provider,
    reason: null,
    updatedAt: at,
    lastUsedAt: null,
  };
  db.insert(apiKeys)
    .values({ id: input.id, userId: input.userId, createdAt: at, ...values })
    .onConflictDoUpdate({ target: apiKeys.id, set: { ...values, createdAt: at } })
    .run();
}

export function remove(db: SessionDatabase, id: string): void {
  db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
}

export function get(db: SessionDatabase, id: string): ApiKeyRow | null {
  return db.select().from(apiKeys).where(eq(apiKeys.id, id)).get() ?? null;
}

export function list(db: SessionDatabase, userId: string): ApiKeyRow[] {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id))
    .all();
}

/** The raw key of `id`, decrypted. */
export function raw(db: SessionDatabase, cipher: KeyCipher, id: string): string | null {
  const row = get(db, id);
  return row ? cipher.open(row.rawEnc) : null;
}

export function setReason(db: SessionDatabase, id: string, reason: string | null): void {
  db.update(apiKeys).set({ reason, updatedAt: now() }).where(eq(apiKeys.id, id)).run();
}

export function markUsed(db: SessionDatabase, id: string, at: number = now()): void {
  db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id)).run();
}
