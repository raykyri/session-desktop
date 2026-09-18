// Token-scoped access to a document from the artifact origin
// (`docs/11-artifacts-and-browser.md`). The artifact host never sees the
// session cookie, so the token in the URL is the whole authorization; it is
// therefore random, per document, and short-lived.

import { randomBytes } from "node:crypto";

import { and, eq, lt } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { artifactTokens } from "../schema/artifacts.js";
import { documents } from "../schema/documents.js";
import { now } from "../time.js";

export const ARTIFACT_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface MintedToken {
  token: string;
  documentId: string;
  expiresAt: number;
}

export function mintToken(
  db: SessionDatabase,
  userId: string,
  documentId: string,
  ttlMs: number = ARTIFACT_TOKEN_TTL_MS,
): MintedToken {
  const owned = db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .get();
  if (!owned) {
    throw new Error(`document ${documentId} was not found`);
  }
  const at = now();
  const token = randomBytes(32).toString("hex");
  const expiresAt = at + ttlMs;
  db.insert(artifactTokens).values({ token, userId, documentId, createdAt: at, expiresAt }).run();
  return { token, documentId, expiresAt };
}

export interface ResolvedToken {
  userId: string;
  documentId: string;
  storagePath: string;
  mime: string;
  name: string;
}

/** Resolves a token to the file it grants, or null when it is unknown or
 * expired. An expired row is deleted on the way out. */
export function resolveToken(db: SessionDatabase, token: string): ResolvedToken | null {
  const at = now();
  const row = db
    .select({
      userId: artifactTokens.userId,
      documentId: artifactTokens.documentId,
      expiresAt: artifactTokens.expiresAt,
      storagePath: documents.storagePath,
      mime: documents.mime,
      name: documents.name,
    })
    .from(artifactTokens)
    .innerJoin(documents, eq(documents.id, artifactTokens.documentId))
    .where(eq(artifactTokens.token, token))
    .get();
  if (!row) {
    return null;
  }
  if (row.expiresAt <= at) {
    db.delete(artifactTokens).where(eq(artifactTokens.token, token)).run();
    return null;
  }
  return {
    userId: row.userId,
    documentId: row.documentId,
    storagePath: row.storagePath,
    mime: row.mime,
    name: row.name,
  };
}

export function revokeExpired(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(artifactTokens)
    .where(lt(artifactTokens.expiresAt, at))
    .returning({ token: artifactTokens.token })
    .all().length;
}
