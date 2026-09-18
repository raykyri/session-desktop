// The journal data model: saved links and X posts, and the reducers that add,
// remove, restore, and re-hydrate them.
//
// Ported from the desktop `src/lib/journal.ts`. The entry types now live in
// `types/journal.ts` with their zod schemas; what stays here is the semantics
// — what a well-formed entry is, and how a stored one is repaired.
//
// Shape, and the room left for what comes next:
// - `JournalState` is a versioned envelope over a flat entry list, stored
//   oldest-first (append order); the feed renders it newest-first. The server
//   stores one row per entry (`02-domain-model-and-database.md` §3.4) and this
//   envelope is what a client holds while editing.
// - Every entry has a stable `id` and a capture `createdAt`, so future layers
//   — grouping related entries, attaching research questions to an entry —
//   can reference entries by id without touching this format.
// - Tweet entries separate what the user gave us (`url`, `tweetId` —
//   permanent) from what hydration fetched (`tweet` — replaceable), so a
//   re-fetch or a failed fetch never loses the entry itself.

import type { RecentActivityItem, RecentActivityPage } from "../types/activity.js";
import type { JournalEntry, JournalTweetEntry, JournalTweetHydration } from "../types/journal.js";
import type { TweetSnapshot } from "../types/tweet.js";

export const JOURNAL_STATE_VERSION = 1;

export interface JournalState {
  version: number;
  /** Oldest first (append order). */
  entries: JournalEntry[];
}

export function emptyJournalState(): JournalState {
  return { version: JOURNAL_STATE_VERSION, entries: [] };
}

export function normalizeJournalEntry(value: unknown): JournalEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { id, createdAt } = raw;
  if (typeof id !== "string" || !id || typeof createdAt !== "string") {
    return null;
  }
  if (raw.kind === "link" && typeof raw.url === "string") {
    return { kind: "link", id, createdAt, url: raw.url };
  }
  if (raw.kind === "tweet" && typeof raw.url === "string" && typeof raw.tweetId === "string") {
    const tweet =
      typeof raw.tweet === "object" && raw.tweet !== null
        ? (raw.tweet as TweetSnapshot)
        : undefined;
    // A stored "ok" without its snapshot (or any unknown status) re-enters
    // hydration rather than rendering an empty card.
    const hydration: JournalTweetHydration =
      raw.hydration === "ok" && tweet ? "ok" : raw.hydration === "failed" ? "failed" : "pending";
    return {
      kind: "tweet",
      id,
      createdAt,
      url: raw.url,
      tweetId: raw.tweetId,
      hydration,
      ...(tweet ? { tweet } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  }
  return null;
}

/** Parse a stored (or server-returned) journal state. Entry-by-entry: a
 * malformed entry is dropped, not the journal. Anything unrecognizable
 * altogether yields the empty state. */
export function normalizeJournalState(value: unknown): JournalState {
  if (typeof value !== "object" || value === null) {
    return emptyJournalState();
  }
  const raw = value as Record<string, unknown>;
  const entries: JournalEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.entries)) {
    for (const candidate of raw.entries) {
      const entry = normalizeJournalEntry(candidate);
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  }
  return { version: JOURNAL_STATE_VERSION, entries };
}

/** Defensive boundary around journal values that reached the feed. A
 * malformed entry is skipped while the server cursor still advances past it. */
export function normalizeRecentActivityPage(page: RecentActivityPage): RecentActivityPage {
  const items: RecentActivityItem[] = [];
  for (const item of page.items) {
    if (item.kind === "research-query") {
      items.push(item);
      continue;
    }
    const entry = normalizeJournalEntry(item.entry);
    if (entry) items.push({ ...item, entry });
  }
  return {
    items,
    nextCursor: page.nextCursor ?? null,
  };
}

export function appendJournalEntry(state: JournalState, entry: JournalEntry): JournalState {
  if (state.entries.some((existing) => existing.id === entry.id)) {
    return state;
  }
  return { ...state, entries: [...state.entries, entry] };
}

export function removeJournalEntry(state: JournalState, id: string): JournalState {
  const entries = state.entries.filter((entry) => entry.id !== id);
  return entries.length === state.entries.length ? state : { ...state, entries };
}

/** Insert an entry at a position (clamped), for undoing a removal. A no-op
 * when the id already exists, so a double-undo can't duplicate. */
export function insertJournalEntryAt(
  state: JournalState,
  entry: JournalEntry,
  index: number,
): JournalState {
  if (state.entries.some((existing) => existing.id === entry.id)) {
    return state;
  }
  const entries = [...state.entries];
  entries.splice(Math.max(0, Math.min(index, entries.length)), 0, entry);
  return { ...state, entries };
}

/** The outcome of a hydration attempt, as the reducers record it. */
export type JournalTweetHydrationResult =
  | { hydration: "pending" }
  | { hydration: "ok"; tweet: TweetSnapshot }
  | { hydration: "failed"; error: string };

/** Record a hydration outcome on a tweet entry. No-op for other kinds or
 * unknown ids (the entry may have been deleted while the fetch was out). */
export function setJournalTweetHydration(
  state: JournalState,
  id: string,
  result: JournalTweetHydrationResult,
): JournalState {
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (entry.id !== id || entry.kind !== "tweet") {
      return entry;
    }
    changed = true;
    return applyJournalTweetHydration(entry, result);
  });
  return changed ? { ...state, entries } : state;
}

export function applyJournalTweetHydration(
  entry: JournalTweetEntry,
  result: JournalTweetHydrationResult,
): JournalTweetEntry {
  if (result.hydration === "ok") {
    // A success clears the previous failure rather than layering on it.
    const hydrated: JournalTweetEntry = { ...entry, hydration: "ok", tweet: result.tweet };
    delete hydrated.error;
    return hydrated;
  }
  if (result.hydration === "failed") {
    return { ...entry, hydration: "failed", error: result.error };
  }
  return { ...entry, hydration: "pending" };
}
