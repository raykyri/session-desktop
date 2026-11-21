// Members' own provider keys (`03-agents-and-research.md` K4). The repository
// stores and returns the sealed form only; sealing and opening happen in the
// server (`server/src/secretBox.ts`), so nothing here ever holds a raw key.

import type { ApiKeyProvider, ApiKeyStatus } from "@session/shared";
import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { apiKeys } from "../schema/apiKeys.js";
import { now } from "../time.js";

export interface StoredApiKey {
  userId: string;
  provider: ApiKeyProvider;
  sealed: string;
  last4: string;
  status: ApiKeyStatus;
  createdAt: number;
  updatedAt: number;
}

/** The member's keys, Anthropic first. */
export function list(db: SessionDatabase, userId: string): StoredApiKey[] {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .all()
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function find(
  db: SessionDatabase,
  userId: string,
  provider: ApiKeyProvider,
): StoredApiKey | null {
  return (
    db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)))
      .get() ?? null
  );
}

/** Saves the member's key for `provider` as `valid`, replacing any earlier
 * one. */
export function save(
  db: SessionDatabase,
  key: { userId: string; provider: ApiKeyProvider; sealed: string; last4: string },
  at: number = now(),
): StoredApiKey {
  return db
    .insert(apiKeys)
    .values({ ...key, status: "valid", createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [apiKeys.userId, apiKeys.provider],
      set: { sealed: key.sealed, last4: key.last4, status: "valid", createdAt: at, updatedAt: at },
    })
    .returning()
    .get();
}

/** Deletes the member's key; true when there was one. */
export function remove(db: SessionDatabase, userId: string, provider: ApiKeyProvider): boolean {
  return (
    db
      .delete(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)))
      .run().changes > 0
  );
}

/** Marks the key `invalid` when its sealed form is still `sealed`: a key the
 * member replaced since the run read it stays as it is. True when a row
 * changed. */
export function markInvalid(
  db: SessionDatabase,
  userId: string,
  provider: ApiKeyProvider,
  sealed: string,
  at: number = now(),
): boolean {
  return (
    db
      .update(apiKeys)
      .set({ status: "invalid", updatedAt: at })
      .where(
        and(
          eq(apiKeys.userId, userId),
          eq(apiKeys.provider, provider),
          eq(apiKeys.sealed, sealed),
          eq(apiKeys.status, "valid"),
        ),
      )
      .run().changes > 0
  );
}
