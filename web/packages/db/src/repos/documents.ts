// Attached files: metadata, extracted text, and the join to the runs that
// carry them as context (`docs/02-domain-model-and-database.md` §3.6,
// `docs/04-agent-runtime.md` §8).

import type { DocumentInfo } from "@session/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { documentText, documents, nodeDocuments } from "../schema/documents.js";
import { nodes } from "../schema/nodes.js";
import { workspaces } from "../schema/workspaces.js";
import { now } from "../time.js";

export interface CreateDocumentInput {
  workspaceId: string;
  name: string;
  mime: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  pageCount?: number | null | undefined;
  extractionStatus?: "pending" | "ok" | "failed" | undefined;
}

function toDocumentInfo(row: typeof documents.$inferSelect): DocumentInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    mime: row.mime,
    byteSize: row.byteSize,
    sha256: row.sha256,
    pageCount: row.pageCount,
    extractionStatus: row.extractionStatus,
    createdAt: row.createdAt,
  };
}

/**
 * Records an uploaded file. Content-addressed per account: re-uploading the
 * same bytes returns the existing row rather than a second copy, which is what
 * `unique (user_id, sha256)` says and what the storage path assumes.
 */
export function create(
  db: SessionDatabase,
  userId: string,
  input: CreateDocumentInput,
): DocumentInfo {
  return transact(db, (tx) => {
    const workspace = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, input.workspaceId)))
      .get();
    if (!workspace) {
      throw new Error(`research workspace ${input.workspaceId} was not found`);
    }
    const existing = tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.sha256, input.sha256)))
      .get();
    if (existing) {
      return toDocumentInfo(existing);
    }
    const row = tx
      .insert(documents)
      .values({
        id: newId(),
        userId,
        workspaceId: input.workspaceId,
        name: input.name,
        mime: input.mime,
        byteSize: input.byteSize,
        sha256: input.sha256,
        storagePath: input.storagePath,
        pageCount: input.pageCount ?? null,
        extractionStatus: input.extractionStatus ?? "pending",
        createdAt: now(),
      })
      .returning()
      .get();
    return toDocumentInfo(row);
  });
}

export function get(db: SessionDatabase, userId: string, documentId: string): DocumentInfo | null {
  const row = db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .get();
  return row ? toDocumentInfo(row) : null;
}

/** The volume path behind a document, which only the server may read. */
export function storagePath(
  db: SessionDatabase,
  userId: string,
  documentId: string,
): string | null {
  const row = db
    .select({ storagePath: documents.storagePath })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .get();
  return row?.storagePath ?? null;
}

export function list(db: SessionDatabase, userId: string, workspaceId?: string): DocumentInfo[] {
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        workspaceId === undefined ? undefined : eq(documents.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id))
    .all()
    .map(toDocumentInfo);
}

/** Bytes stored for one account, against the per-user upload budget. */
export function totalBytes(db: SessionDatabase, userId: string): number {
  const row = db
    .select({ value: sql<number | null>`sum(${documents.byteSize})` })
    .from(documents)
    .where(eq(documents.userId, userId))
    .get();
  return row?.value ?? 0;
}

export function setExtraction(
  db: SessionDatabase,
  userId: string,
  documentId: string,
  input: { status: "pending" | "ok" | "failed"; pageCount?: number | null; pages?: string[] },
): DocumentInfo {
  return transact(db, (tx) => {
    const row = tx
      .update(documents)
      .set({
        extractionStatus: input.status,
        pageCount: input.pageCount ?? (input.pages ? input.pages.length : null),
      })
      .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
      .returning()
      .get();
    if (!row) {
      throw new Error(`document ${documentId} was not found`);
    }
    if (input.pages) {
      tx.delete(documentText).where(eq(documentText.documentId, documentId)).run();
      input.pages.forEach((text, page) => {
        tx.insert(documentText).values({ documentId, page, text }).run();
      });
    }
    return toDocumentInfo(row);
  });
}

/** Extracted text, per page for PDFs and as a single page 0 otherwise. */
export function readText(
  db: SessionDatabase,
  userId: string,
  documentId: string,
  page?: number,
): string[] {
  const owned = get(db, userId, documentId);
  if (!owned) {
    return [];
  }
  return db
    .select({ page: documentText.page, text: documentText.text })
    .from(documentText)
    .where(
      and(
        eq(documentText.documentId, documentId),
        page === undefined ? undefined : eq(documentText.page, page),
      ),
    )
    .orderBy(asc(documentText.page))
    .all()
    .map((row) => row.text);
}

/**
 * Attaches documents to a node in display order, replacing any existing set —
 * the body of `attach`, without a transaction of its own, for the repositories
 * that create a node and attach its documents in one.
 *
 * Every id is checked against `userId` here rather than by the caller. A
 * `node_documents` row written from an unchecked id is a cross-tenant write:
 * the row is invisible to its owner, and `remove` refuses a document a node
 * references, so one account could pin another account's file in place for
 * good.
 */
export function attachWithin(
  tx: SessionDatabase,
  userId: string,
  nodeId: string,
  documentIds: readonly string[],
): void {
  const node = tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  tx.delete(nodeDocuments).where(eq(nodeDocuments.nodeId, nodeId)).run();
  documentIds.forEach((documentId, position) => {
    if (!get(tx, userId, documentId)) {
      throw new Error(`document ${documentId} was not found`);
    }
    tx.insert(nodeDocuments).values({ nodeId, documentId, position }).run();
  });
}

/** Attaches documents to a node in display order, replacing any existing set. */
export function attach(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  documentIds: readonly string[],
): void {
  transact(db, (tx) => {
    attachWithin(tx, userId, nodeId, documentIds);
  });
}

export function attachedTo(db: SessionDatabase, userId: string, nodeId: string): DocumentInfo[] {
  return db
    .select({ document: documents })
    .from(nodeDocuments)
    .innerJoin(documents, eq(documents.id, nodeDocuments.documentId))
    .where(and(eq(documents.userId, userId), eq(nodeDocuments.nodeId, nodeId)))
    .orderBy(asc(nodeDocuments.position))
    .all()
    .map((row) => toDocumentInfo(row.document));
}

export interface DocumentRemoval {
  removed: boolean;
  /**
   * Volume paths no row references any more. Deleting the row is only half of
   * a delete: the bytes sit under `${SESSION_DATA_DIR}/documents/<user>/<sha>`
   * and the per-user quota is computed from rows, so a delete-and-reupload
   * cycle would leak disk without bound. The caller unlinks these — filesystem
   * work has no place inside a SQLite transaction, and the database package
   * has no business touching the volume (ADR-1).
   */
  orphanedPaths: string[];
}

/** The paths of `documentIds` that no surviving row still points at. Content
 * is addressed by `(user_id, sha256)`, which `documents_user_sha_uq` makes
 * unique, so in practice this is one path per removed row; the query is by
 * path anyway so that a future second row over the same bytes cannot make this
 * unlink a file another document is still using. */
function orphanedPathsOf(tx: SessionDatabase, paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    (path) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.storagePath, path))
        .get() === undefined,
  );
}

/** Refused while a node still references the document: its bytes are part of
 * that run's context and the thread would lose the ability to explain itself. */
export function remove(db: SessionDatabase, userId: string, documentId: string): DocumentRemoval {
  return transact(db, (tx) => {
    const row = tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
      .get();
    if (!row) {
      return { removed: false, orphanedPaths: [] };
    }
    const referenced = tx
      .select({ nodeId: nodeDocuments.nodeId })
      .from(nodeDocuments)
      .where(eq(nodeDocuments.documentId, documentId))
      .get();
    if (referenced) {
      throw new Error("this document is attached to research and cannot be removed");
    }
    tx.delete(documents).where(eq(documents.id, documentId)).run();
    return { removed: true, orphanedPaths: orphanedPathsOf(tx, [row.storagePath]) };
  });
}

/**
 * Every volume path this account's rows point at, read *before* the account is
 * deleted. `users` cascades the rows away and leaves the bytes behind, so the
 * caller takes this list first and unlinks it after the delete lands.
 */
export function storagePathsOf(db: SessionDatabase, userId: string): string[] {
  return [
    ...new Set(
      db
        .select({ storagePath: documents.storagePath })
        .from(documents)
        .where(eq(documents.userId, userId))
        .all()
        .map((row) => row.storagePath),
    ),
  ];
}

/** Every path any row points at. The volume sweep keeps what is in here and
 * unlinks the rest — which is how the cascades that nobody can hand a path to
 * (a removed workspace, a removed tree) stop leaking. */
export function allStoragePaths(db: SessionDatabase): Set<string> {
  return new Set(
    db
      .select({ storagePath: documents.storagePath })
      .from(documents)
      .all()
      .map((row) => row.storagePath),
  );
}
