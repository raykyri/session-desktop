// Saved links and X posts (`docs/02-domain-model-and-database.md` §3.4,
// §5.12).
//
// The entry is stored whole and validated with the strict shared schema; the
// columns beside it are projections the feed and hydration query on. Strict schema validation is enforced for all entries; unparseable entries are rejected as errors.

import type { JournalEntry } from "@session/shared";
import { journalEntrySchema } from "@session/shared";
import { and, asc, desc, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { parseJsonColumn } from "../json.js";
import { journalEntries } from "../schema/journal.js";

/** Milliseconds for the feed's ordering; entries carry an ISO string. */
function occurredAt(entry: JournalEntry): number {
  const parsed = Date.parse(entry.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The plain text of a tweet entry, for search and for the card's fallback. */
function entryText(entry: JournalEntry): string | null {
  if (entry.kind !== "tweet" || !entry.tweet) {
    return null;
  }
  return entry.tweet.runs.map((run) => run.text).join("");
}

function projection(userId: string, entry: JournalEntry): typeof journalEntries.$inferInsert {
  return {
    id: entry.id,
    userId,
    kind: entry.kind,
    createdAt: occurredAt(entry),
    url: entry.url,
    tweetId: entry.kind === "tweet" ? entry.tweetId : null,
    hydration: entry.kind === "tweet" ? entry.hydration : null,
    text: entryText(entry),
    entryJson: entry,
  };
}

function toEntry(row: typeof journalEntries.$inferSelect): JournalEntry {
  return parseJsonColumn(journalEntrySchema, row.entryJson, "journal_entries.entry_json");
}

/** Adds an entry. Rejects a duplicate id rather than silently replacing one:
 * `add` is a new entry, `update` is a change to a known one. */
export function add(db: SessionDatabase, userId: string, entry: JournalEntry): JournalEntry {
  const parsed = journalEntrySchema.parse(entry);
  return transact(db, (tx) => {
    const existing = tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, parsed.id)))
      .get();
    if (existing) {
      throw new Error(`journal entry ${parsed.id} already exists`);
    }
    tx.insert(journalEntries).values(projection(userId, parsed)).run();
    return parsed;
  });
}

/**
 * Puts an entry back after an undo. Idempotent: restoring twice is one entry,
 * which is what an undo that was clicked twice should mean.
 *
 * The upsert is scoped to the account, as `update` is. Entry ids come from the
 * client — an undo replays the entry the client was holding — so an unscoped
 * `on conflict (id) do update` lets one account overwrite another's entry by
 * restoring something carrying its id (`06-auth-and-users.md` §4). A conflict
 * on someone else's id is a miss, not a takeover.
 */
export function restore(db: SessionDatabase, userId: string, entry: JournalEntry): boolean {
  const parsed = journalEntrySchema.parse(entry);
  const values = projection(userId, parsed);
  return transact(db, (tx) => {
    const existing = tx
      .select({ userId: journalEntries.userId })
      .from(journalEntries)
      .where(eq(journalEntries.id, parsed.id))
      .get();
    if (existing && existing.userId !== userId) {
      return false;
    }
    const row = tx
      .insert(journalEntries)
      .values(values)
      .onConflictDoUpdate({
        target: journalEntries.id,
        set: values,
        where: eq(journalEntries.userId, userId),
      })
      .returning({ id: journalEntries.id })
      .get();
    return row !== undefined;
  });
}

/** Replaces an existing entry — a hydration result, mostly. Returns false when
 * the account has no such entry. */
export function update(
  db: SessionDatabase,
  userId: string,
  id: string,
  entry: JournalEntry,
): boolean {
  const parsed = journalEntrySchema.parse(entry);
  if (parsed.id !== id) {
    throw new Error("Cannot update journal entry ID: ID is immutable.");
  }
  const values = projection(userId, parsed);
  const row = db
    .update(journalEntries)
    .set(values)
    .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, id)))
    .returning({ id: journalEntries.id })
    .get();
  return row !== undefined;
}

export function remove(db: SessionDatabase, userId: string, id: string): boolean {
  const row = db
    .delete(journalEntries)
    .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, id)))
    .returning({ id: journalEntries.id })
    .get();
  return row !== undefined;
}

export function get(db: SessionDatabase, userId: string, id: string): JournalEntry | null {
  const row = db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, id)))
    .get();
  return row ? toEntry(row) : null;
}

export function list(
  db: SessionDatabase,
  userId: string,
  options: { limit?: number; oldestFirst?: boolean } = {},
): JournalEntry[] {
  const order = options.oldestFirst
    ? [asc(journalEntries.createdAt), asc(journalEntries.id)]
    : [desc(journalEntries.createdAt), desc(journalEntries.id)];
  const query = db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.userId, userId))
    .orderBy(...order);
  const rows = options.limit === undefined ? query.all() : query.limit(options.limit).all();
  return rows.map(toEntry);
}

/** Tweet entries awaiting hydration, for the background fetcher. */
export function pendingTweets(db: SessionDatabase, userId: string, limit = 20): JournalEntry[] {
  return db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.kind, "tweet"),
        eq(journalEntries.hydration, "pending"),
      ),
    )
    .orderBy(asc(journalEntries.createdAt))
    .limit(limit)
    .all()
    .map(toEntry);
}
