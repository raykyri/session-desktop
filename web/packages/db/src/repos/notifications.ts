// The notification inbox (`docs/02-domain-model-and-database.md` §5.17).
// The server stores every notification it sends (`server/src/research/
// notifications.ts`), one row per recipient; the recipient lists them, marks
// them read, and reads an unread count. Rows are the recipient's alone.
//
// Retention: a recipient keeps at most `MAX_NOTIFICATIONS_PER_USER` (the
// oldest go first, read or not), and a read notification is deleted
// `READ_NOTIFICATION_RETENTION_MS` after it was read (`prune`, run by the
// server's maintenance tick).

import type { InboxNotification, InboxNotificationPage } from "@session/shared";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { notifications } from "../schema/notifications.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

/** Most notifications one person keeps. */
export const MAX_NOTIFICATIONS_PER_USER = 500;

/** How long a read notification is kept. */
export const READ_NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default and largest page of `list`. */
export const NOTIFICATION_PAGE_SIZE = 30;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

type Row = typeof notifications.$inferSelect;

export interface NewNotification {
  id: string;
  userId: string;
  kind: Row["kind"];
  tone: Row["tone"];
  treeId: string | null;
  title: string;
  body: string;
  href: string | null;
  createdAt: number;
}

function toInbox(row: Row): InboxNotification {
  return {
    id: row.id,
    kind: row.kind,
    tone: row.tone,
    treeId: row.treeId,
    title: row.title,
    body: row.body,
    href: row.href,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

/** Drops `userId`'s notifications beyond the newest
 * `MAX_NOTIFICATIONS_PER_USER`. */
function capFor(db: SessionDatabase, userId: string): void {
  db.run(sql`
    DELETE FROM ${notifications}
    WHERE ${notifications.userId} = ${userId}
      AND ${notifications.id} IN (
        SELECT ${notifications.id} FROM ${notifications}
        WHERE ${notifications.userId} = ${userId}
        ORDER BY ${notifications.createdAt} DESC, ${notifications.id} DESC
        LIMIT -1 OFFSET ${MAX_NOTIFICATIONS_PER_USER}
      )
  `);
}

/**
 * Stores notifications, one row per recipient, and keeps each recipient
 * within the cap. A notification about a thread that no longer exists is
 * stored without its thread (and its link still names the path it had).
 */
export function record(db: SessionDatabase, rows: readonly NewNotification[]): void {
  if (rows.length === 0) {
    return;
  }
  transact(db, (tx) => {
    const treeIds = [...new Set(rows.flatMap((row) => (row.treeId === null ? [] : [row.treeId])))];
    const existing = new Set(
      treeIds.length === 0
        ? []
        : tx
            .select({ id: trees.id })
            .from(trees)
            .where(inArray(trees.id, treeIds))
            .all()
            .map((row) => row.id),
    );
    tx.insert(notifications)
      .values(
        rows.map((row) => ({
          ...row,
          treeId: row.treeId !== null && existing.has(row.treeId) ? row.treeId : null,
          readAt: null,
        })),
      )
      .onConflictDoNothing()
      .run();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      capFor(tx, userId);
    }
  });
}

/** The cursor of the row after which the next page starts. */
function cursorOf(row: Row): string {
  return `${row.createdAt}:${row.id}`;
}

function parseCursor(cursor: string): { createdAt: number; id: string } | null {
  const separator = cursor.indexOf(":");
  const createdAt = Number(cursor.slice(0, separator));
  return separator > 0 && Number.isSafeInteger(createdAt)
    ? { createdAt, id: cursor.slice(separator + 1) }
    : null;
}

/** `userId`'s notifications, newest first, a page at a time. */
export function list(
  db: SessionDatabase,
  userId: string,
  options: { cursor?: string | null; limit?: number } = {},
): InboxNotificationPage {
  const limit = Math.min(
    MAX_NOTIFICATION_PAGE_SIZE,
    Math.max(1, Math.floor(options.limit ?? NOTIFICATION_PAGE_SIZE)),
  );
  const after = options.cursor ? parseCursor(options.cursor) : null;
  const rows = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        after
          ? or(
              lt(notifications.createdAt, after.createdAt),
              and(eq(notifications.createdAt, after.createdAt), lt(notifications.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toInbox),
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  };
}

/** How many of `userId`'s notifications are unread. */
export function unreadCount(db: SessionDatabase, userId: string): number {
  return (
    db
      .select({ value: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .get()?.value ?? 0
  );
}

/** Marks one of `userId`'s notifications read. Answers whether it changed
 * (false for an unknown id, another person's, or one already read). */
export function markRead(db: SessionDatabase, userId: string, id: string): boolean {
  return (
    db
      .update(notifications)
      .set({ readAt: now() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id })
      .all().length > 0
  );
}

/** Marks every unread notification of `userId` read; answers how many. */
export function markAllRead(db: SessionDatabase, userId: string): number {
  return db
    .update(notifications)
    .set({ readAt: now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
    .all().length;
}

/** Deletes read notifications older than the retention, and each person's
 * notifications beyond the cap. Answers how many rows went. */
export function prune(db: SessionDatabase, at: number = now()): number {
  return transact(db, (tx) => {
    const expired = tx
      .delete(notifications)
      .where(lt(notifications.readAt, at - READ_NOTIFICATION_RETENTION_MS))
      .returning({ id: notifications.id })
      .all().length;
    const over = tx.all<{ id: string }>(sql`
      SELECT id FROM (
        SELECT ${notifications.id} AS id,
          ROW_NUMBER() OVER (
            PARTITION BY ${notifications.userId}
            ORDER BY ${notifications.createdAt} DESC, ${notifications.id} DESC
          ) AS rank
        FROM ${notifications}
      )
      WHERE rank > ${MAX_NOTIFICATIONS_PER_USER}
    `);
    let capped = 0;
    for (let start = 0; start < over.length; start += 500) {
      const ids = over.slice(start, start + 500).map((row) => row.id);
      capped += tx
        .delete(notifications)
        .where(inArray(notifications.id, ids))
        .returning({ id: notifications.id })
        .all().length;
    }
    return expired + capped;
  });
}
