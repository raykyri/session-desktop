// The journal and the tweet proxy (`03-api-and-events.md` §2,
// `10-home-feed-journal-encyclopedia.md` §3).

import { tweets } from "@session/db";
import test from "ava";

import { syndicationUrl, validateTweetFetchArgs } from "../src/journal/tweets.js";

import { createHarness } from "./helpers.js";

const TWEET_ID = "1599367266448994304";
const TWEET_URL = `https://x.com/session/status/${TWEET_ID}`;

const PAYLOAD = {
  __typename: "Tweet",
  id_str: TWEET_ID,
  text: "A post about bloom filters",
  created_at: "2022-12-04T00:00:00.000Z",
  favorite_count: 3,
  user: { screen_name: "session", name: "Session", is_blue_verified: false },
};

interface FetchLog {
  urls: string[];
  status?: number;
  body?: string;
}

function syndicationFetch(log: FetchLog): typeof globalThis.fetch {
  return (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.urls.push(url);
    return Promise.resolve(
      new Response(log.body ?? JSON.stringify(PAYLOAD), {
        status: log.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

test("adding a post URL creates a tweet entry and hydrates it once", async (t) => {
  const log: FetchLog = { urls: [] };
  const harness = createHarness(t, { fetch: syndicationFetch(log) });
  const user = harness.addUser("reader");
  const caller = harness.caller(user);

  const entry = await caller.journal.add({ url: TWEET_URL });
  t.is(entry.kind, "tweet");
  t.is(entry.kind === "tweet" ? entry.hydration : null, "ok");
  t.is(entry.kind === "tweet" ? entry.tweet?.author.handle : null, "session");
  t.is(log.urls.length, 1);
  // The URL is assembled by the server from the id and the derived token.
  t.true(log.urls[0]?.startsWith("https://cdn.syndication.twimg.com/tweet-result?"));
  t.true(log.urls[0]?.includes(`id=${TWEET_ID}`));
  t.true(log.urls[0]?.includes("lang=en"));
  t.truthy(tweets.get(harness.db, TWEET_ID));

  // A second hydration is answered from `tweet_cache`.
  const rehydrated = await caller.journal.hydrateTweet({ entryId: entry.id });
  t.is(rehydrated.hydration, "ok");
  t.is(log.urls.length, 1);
});

test("a plain URL becomes a link entry, and a bad URL is refused", async (t) => {
  const harness = createHarness(t, { fetch: syndicationFetch({ urls: [] }) });
  const caller = harness.caller(harness.addUser("reader"));
  const entry = await caller.journal.add({ url: "https://example.com/post" });
  t.is(entry.kind, "link");
  await t.throwsAsync(caller.journal.add({ url: "javascript:alert(1)" }), {
    message: /does not look like a link/,
  });
  const removed = await caller.journal.remove({ id: entry.id });
  t.true(removed);
  // An id that is gone and an id that was never this account's answer the same
  // way, so a foreign id is never an existence oracle
  // (`06-auth-and-users.md` §4). `update` has always answered like this.
  await t.throwsAsync(caller.journal.remove({ id: entry.id }), { message: /was not found/ });
});

test("restore and update re-validate the URL they are handed", async (t) => {
  const harness = createHarness(t, { fetch: syndicationFetch({ urls: [] }) });
  const caller = harness.caller(harness.addUser("reader"));
  const entry = await caller.journal.add({ url: "https://example.com/post" });
  t.true(await caller.journal.remove({ id: entry.id }));

  // `add` is not the only door: both of these take the whole row from the
  // caller, so the one check `add` makes has to be made here too.
  await t.throwsAsync(
    caller.journal.restore({ entry: { ...entry, url: "javascript:alert(1)" } }),
    { message: /does not look like a link/ },
    "a restored row cannot smuggle a script URL back in",
  );
  await t.throwsAsync(
    caller.journal.update({ id: entry.id, entry: { ...entry, url: "file:///etc/passwd" } }),
    { message: /does not look like a link/ },
    "and neither can an update",
  );

  // The ordinary path still works, and the stored URL is the normalized one.
  const restored = await caller.journal.restore({ entry });
  t.true(restored);
  const updated = await caller.journal.update({
    id: entry.id,
    entry: { ...entry, url: "https://example.com/moved" },
  });
  t.true(updated);
});

test("a restored post's permalink is checked too", async (t) => {
  const log: FetchLog = { urls: [] };
  const harness = createHarness(t, { fetch: syndicationFetch(log) });
  const caller = harness.caller(harness.addUser("reader"));
  const entry = await caller.journal.add({ url: TWEET_URL });
  t.is(entry.kind === "tweet" ? entry.tweet?.url : null, TWEET_URL);
  if (entry.kind !== "tweet" || !entry.tweet) {
    t.fail("the fixture hydrates into a tweet entry");
    return;
  }
  await t.throwsAsync(
    caller.journal.restore({
      entry: { ...entry, tweet: { ...entry.tweet, url: "javascript:alert(1)" } },
    }),
    { message: /does not look like a link/ },
    "the snapshot's own permalink reaches an href in the card",
  );
});

test("an unavailable post is recorded as a failed hydration, not an error", async (t) => {
  const log: FetchLog = { urls: [], status: 404, body: "not found" };
  const harness = createHarness(t, { fetch: syndicationFetch(log) });
  const caller = harness.caller(harness.addUser("reader"));
  const entry = await caller.journal.add({ url: TWEET_URL });
  t.is(entry.kind === "tweet" ? entry.hydration : null, "failed");
  t.true((entry.kind === "tweet" ? entry.error : "")?.includes("404"));
});

test("fetchTweet validates its arguments and builds the URL itself", async (t) => {
  const log: FetchLog = { urls: [] };
  const harness = createHarness(t, { fetch: syndicationFetch(log) });
  const caller = harness.caller(harness.addUser("reader"));

  const raw = await caller.journal.fetchTweet({ id: TWEET_ID, token: "abc123" });
  t.is((JSON.parse(raw) as { id_str: string }).id_str, TWEET_ID);
  t.is(log.urls[0], syndicationUrl(TWEET_ID, "abc123"));

  for (const bad of [
    { id: "not-numeric", token: "abc" },
    { id: "", token: "abc" },
    { id: "1".repeat(26), token: "abc" },
    { id: TWEET_ID, token: "bad token!" },
    { id: TWEET_ID, token: "" },
  ]) {
    await t.throwsAsync(
      caller.journal.fetchTweet(bad),
      { message: /invalid tweet/ },
      JSON.stringify(bad),
    );
  }
  t.is(log.urls.length, 1);
});

test("fetchTweet is rate limited per account", async (t) => {
  const harness = createHarness(t, { fetch: syndicationFetch({ urls: [] }) });
  const caller = harness.caller(harness.addUser("reader"));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await caller.journal.fetchTweet({ id: TWEET_ID, token: "abc" });
  }
  await t.throwsAsync(caller.journal.fetchTweet({ id: TWEET_ID, token: "abc" }), {
    message: /too many tweet lookups/,
  });
});

test("the argument shapes match the desktop's", (t) => {
  t.notThrows(() => validateTweetFetchArgs(TWEET_ID, "abc123"));
  t.throws(() => validateTweetFetchArgs("12a", "abc"), { message: "invalid tweet id" });
  t.throws(() => validateTweetFetchArgs(TWEET_ID, "a".repeat(33)), {
    message: "invalid tweet token",
  });
});
