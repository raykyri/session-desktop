// Uploaded images (phase 2a): the rows; who may read one is the server's
// decision through the space read rules.

import { eq, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { newId } from "../ids.js";
import { uploads } from "../schema/uploads.js";
import { now } from "../time.js";

export type UploadRow = typeof uploads.$inferSelect;

export function create(
  db: SessionDatabase,
  userId: string,
  input: Omit<UploadRow, "id" | "userId" | "createdAt">,
): UploadRow {
  return db
    .insert(uploads)
    .values({ id: newId(), userId, createdAt: now(), ...input })
    .returning()
    .get();
}

export function get(db: SessionDatabase, id: string): UploadRow | null {
  return db.select().from(uploads).where(eq(uploads.id, id)).get() ?? null;
}

/** Bytes a user keeps, for the quota. */
export function storedBytes(db: SessionDatabase, userId: string): number {
  return (
    db
      .select({ n: sql<number | null>`sum(${uploads.byteSize})` })
      .from(uploads)
      .where(eq(uploads.userId, userId))
      .get()?.n ?? 0
  );
}
