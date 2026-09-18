import type { JournalEntry } from "@session/shared";
import test from "ava";

import { journal } from "../src/index.js";

import { createFixture } from "./helpers.js";

const LINK: JournalEntry = {
  id: "j1",
  kind: "link",
  url: "https://example.com/a",
  createdAt: "2024-05-01T10:00:00.000Z",
};

const TWEET: JournalEntry = {
  id: "j2",
  kind: "tweet",
  url: "https://x.com/someone/status/12345",
  tweetId: "12345",
  hydration: "pending",
  createdAt: "2024-05-02T10:00:00.000Z",
};

test("entries are stored whole and read back unchanged", (t) => {
  const fixture = createFixture(t);
  t.deepEqual(journal.add(fixture.db, fixture.userId, LINK), LINK);
  t.deepEqual(journal.get(fixture.db, fixture.userId, "j1"), LINK);
  t.throws(() => journal.add(fixture.db, fixture.userId, LINK), { message: /already exists/ });
});

test("the projections follow the entry", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, TWEET);
  const row = fixture.db.$client
    .prepare(
      `SELECT kind, created_at AS createdAt, tweet_id AS tweetId, hydration FROM journal_entries`,
    )
    .get();
  t.deepEqual(row, {
    kind: "tweet",
    createdAt: Date.parse(TWEET.createdAt),
    tweetId: "12345",
    hydration: "pending",
  });
});

test("hydration replaces the entry in place", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, TWEET);
  const hydrated: JournalEntry = {
    ...TWEET,
    hydration: "ok",
    tweet: {
      id: "12345",
      url: "https://x.com/someone/status/12345",
      author: { name: "Someone", handle: "someone" },
      runs: [{ kind: "text", text: "A post about birdsong." }],
      partial: false,
      media: [],
    },
  };
  t.true(journal.update(fixture.db, fixture.userId, "j2", hydrated));
  t.deepEqual(journal.get(fixture.db, fixture.userId, "j2"), hydrated);
  const row = fixture.db.$client.prepare(`SELECT text FROM journal_entries WHERE id = 'j2'`).get();
  t.deepEqual(row, { text: "A post about birdsong." });
  t.deepEqual(journal.pendingTweets(fixture.db, fixture.userId), []);
  t.throws(() => journal.update(fixture.db, fixture.userId, "j2", { ...hydrated, id: "other" }), {
    message: /Cannot update journal entry ID/,
  });
});

test("remove and restore are the undo pair", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, LINK);
  t.true(journal.remove(fixture.db, fixture.userId, "j1"));
  t.false(journal.remove(fixture.db, fixture.userId, "j1"));
  t.true(journal.restore(fixture.db, fixture.userId, LINK));
  t.true(journal.restore(fixture.db, fixture.userId, LINK), "restoring twice is still one entry");
  t.is(journal.list(fixture.db, fixture.userId).length, 1);
});

test("listing is newest first and scoped to the account", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, LINK);
  journal.add(fixture.db, fixture.userId, TWEET);
  t.deepEqual(
    journal.list(fixture.db, fixture.userId).map((entry) => entry.id),
    ["j2", "j1"],
  );
  t.deepEqual(
    journal.list(fixture.db, fixture.userId, { oldestFirst: true }).map((entry) => entry.id),
    ["j1", "j2"],
  );
  t.deepEqual(journal.list(fixture.db, "someone-else"), []);
});

test("an entry that is not a link or a tweet is refused", (t) => {
  const fixture = createFixture(t);
  t.throws(() =>
    journal.add(fixture.db, fixture.userId, { id: "j3", kind: "note" } as unknown as JournalEntry),
  );
});
