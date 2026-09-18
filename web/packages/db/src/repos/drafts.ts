// Interface drafts: client state that has to survive a reload on another
// device (`docs/02-domain-model-and-database.md` §3.1).

import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { interfaceDrafts } from "../schema/drafts.js";
import { now } from "../time.js";

export const MAX_DRAFT_KEY_BYTES = 128;
/** The desktop allowed 12 MiB because the value never left the machine; on the
 * web every draft crosses the wire and shares a volume. */
export const MAX_DRAFT_VALUE_BYTES = 1024 * 1024;

export function get(db: SessionDatabase, userId: string, key: string): string | null {
  const row = db
    .select({ value: interfaceDrafts.value })
    .from(interfaceDrafts)
    .where(and(eq(interfaceDrafts.userId, userId), eq(interfaceDrafts.key, key)))
    .get();
  return row?.value ?? null;
}

export function set(db: SessionDatabase, userId: string, key: string, value: string): void {
  if (Buffer.byteLength(key, "utf8") > MAX_DRAFT_KEY_BYTES) {
    throw new Error(`draft keys cannot exceed ${MAX_DRAFT_KEY_BYTES} bytes`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_DRAFT_VALUE_BYTES) {
    throw new Error(`a draft cannot exceed ${MAX_DRAFT_VALUE_BYTES} bytes`);
  }
  const at = now();
  db.insert(interfaceDrafts)
    .values({ userId, key, value, updatedAt: at })
    .onConflictDoUpdate({
      target: [interfaceDrafts.userId, interfaceDrafts.key],
      set: { value, updatedAt: at },
    })
    .run();
}

export function remove(db: SessionDatabase, userId: string, key: string): boolean {
  const row = db
    .delete(interfaceDrafts)
    .where(and(eq(interfaceDrafts.userId, userId), eq(interfaceDrafts.key, key)))
    .returning({ key: interfaceDrafts.key })
    .get();
  return row !== undefined;
}
