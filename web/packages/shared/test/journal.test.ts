import test from "ava";

import {
  appendJournalEntry,
  applyJournalTweetHydration,
  emptyJournalState,
  insertJournalEntryAt,
  normalizeJournalState,
  normalizeRecentActivityPage,
  removeJournalEntry,
  setJournalTweetHydration,
} from "../src/journal/entries.js";
import { tweetSnapshotFromSyndication } from "../src/journal/tweets.js";
import type { JournalEntry, JournalTweetEntry } from "../src/types/journal.js";
import type { TweetSnapshot } from "../src/types/tweet.js";

import plain from "./fixtures/journal/20.json" with { type: "json" };

/** The captured syndication payload for @jack's first post. */
function snapshot(id: "20"): TweetSnapshot {
  const parsed = tweetSnapshotFromSyndication(id, plain);
  if (!parsed) throw new Error(`fixture ${id} should hydrate`);
  return parsed;
}

function tweetEntry(tweet: TweetSnapshot): JournalTweetEntry {
  return {
    kind: "tweet",
    id: `entry-${tweet.id}`,
    createdAt: "2026-08-27T00:00:00.000Z",
    url: tweet.url,
    tweetId: tweet.id,
    hydration: "ok",
    tweet,
  };
}

function linkEntry(id: string, url = `https://example.com/${id}`): JournalEntry {
  return { kind: "link", id, createdAt: "2026-08-27T00:00:00.000Z", url };
}

function pendingTweetEntry(id = "a"): JournalTweetEntry {
  return {
    kind: "tweet",
    id,
    createdAt: "2026-08-27T00:00:00.000Z",
    url: "https://x.com/jack/status/20",
    tweetId: "20",
    hydration: "pending",
  };
}

test("journal state drops unrecognized entries and normalizes the rest", (t) => {
  const state = {
    version: 1,
    entries: [linkEntry("a"), linkEntry("b"), tweetEntry(snapshot("20"))],
  };
  const roundTripped = normalizeJournalState(JSON.parse(JSON.stringify(state)) as unknown);
  t.deepEqual(roundTripped, state);

  const scrubbed = normalizeJournalState({
    version: 99,
    entries: [
      ...state.entries,
      { kind: "mystery", id: "z", createdAt: "2026-01-01" },
      { kind: "link", id: "", createdAt: "2026-01-01", url: "https://example.com" },
      { ...state.entries[0] },
      "garbage",
    ],
  });
  t.deepEqual(scrubbed, state);
  t.deepEqual(normalizeJournalState(null), emptyJournalState());
  t.deepEqual(normalizeJournalState("junk"), emptyJournalState());
});

test("a stored ok-without-snapshot tweet re-enters hydration", (t) => {
  const state = normalizeJournalState({
    version: 1,
    entries: [
      {
        kind: "tweet",
        id: "a",
        createdAt: "2026-08-27T00:00:00.000Z",
        url: "https://x.com/jack/status/20",
        tweetId: "20",
        hydration: "ok",
      },
    ],
  });
  t.is((state.entries[0] as JournalTweetEntry).hydration, "pending");
});

test("the hydration reducer records outcomes and tolerates deleted entries", (t) => {
  const pending = pendingTweetEntry();
  const state = appendJournalEntry(emptyJournalState(), pending);
  const failed = setJournalTweetHydration(state, "a", { hydration: "failed", error: "boom" });
  t.is((failed.entries[0] as JournalTweetEntry).hydration, "failed");
  t.is((failed.entries[0] as JournalTweetEntry).error, "boom");
  const ok = setJournalTweetHydration(failed, "a", { hydration: "ok", tweet: snapshot("20") });
  const okEntry = ok.entries[0] as JournalTweetEntry;
  t.is(okEntry.hydration, "ok");
  // A success clears the previous failure rather than layering on it.
  t.is(okEntry.error, undefined);
  t.is(okEntry.tweet?.author.handle, "jack");
  // Unknown ids (entry deleted while the fetch was out) are a no-op.
  t.is(setJournalTweetHydration(ok, "gone", { hydration: "pending" }), ok);
  t.deepEqual(removeJournalEntry(ok, "a").entries, []);
});

test("hydration applies to one entry without touching the state around it", (t) => {
  const entry = applyJournalTweetHydration(pendingTweetEntry(), {
    hydration: "failed",
    error: "boom",
  });
  t.is(entry.hydration, "failed");
  t.is(applyJournalTweetHydration(entry, { hydration: "pending" }).hydration, "pending");
});

test("insert-at restores a removed entry at its original position", (t) => {
  const at = (n: number) => linkEntry(`id${n}`);
  let state = emptyJournalState();
  for (const n of [0, 1, 2]) {
    state = appendJournalEntry(state, at(n));
  }
  const removed = removeJournalEntry(state, "id1");
  const restored = insertJournalEntryAt(removed, at(1), 1);
  t.deepEqual(restored, state);
  // Double-undo can't duplicate.
  t.is(insertJournalEntryAt(restored, at(1), 1), restored);
  // Out-of-range indices clamp instead of throwing.
  t.is(insertJournalEntryAt(removed, at(1), 99).entries.length, 3);
  t.is(insertJournalEntryAt(removed, at(1), -5).entries[0]?.id, "id1");
});

test("append dedupes by id", (t) => {
  const link = linkEntry("a");
  const state = appendJournalEntry(emptyJournalState(), link);
  t.is(appendJournalEntry(state, link), state);
});

test("activity page normalization drops malformed journal records", (t) => {
  const page = normalizeRecentActivityPage({
    items: [
      {
        kind: "journal",
        occurredAt: 11,
        entry: { kind: "link", id: "kept", createdAt: "2026-01-01", url: "https://example.com" },
      },
      {
        kind: "journal",
        occurredAt: 10,
        entry: { id: "broken" } as unknown as JournalEntry,
      },
    ],
    nextCursor: { occurredAt: 10, sourceRank: 0, id: "broken" },
  });
  t.deepEqual(
    page.items.map((item) => (item.kind === "journal" ? item.entry.id : "")),
    ["kept"],
  );
  // The cursor still advances past the entry that was dropped.
  t.deepEqual(page.nextCursor, { occurredAt: 10, sourceRank: 0, id: "broken" });
  t.is(normalizeRecentActivityPage({ items: [] }).nextCursor, null);
});
