import test from "ava";

import {
  MAX_TWEETS_PER_MESSAGE,
  classifyTweetFetchFailure,
  syndicationToken,
  tweetAttachmentFromFetch,
  tweetIdFromUrl,
  tweetReferences,
  tweetSnapshotFromSyndication,
} from "../src/journal/tweets.js";
import type { TweetSnapshot } from "../src/types/tweet.js";

import video from "./fixtures/journal/1585341984679469056.json" with { type: "json" };
import quote from "./fixtures/journal/1599367266448994304.json" with { type: "json" };
import longPost from "./fixtures/journal/1623411400545632256.json" with { type: "json" };
import linkCard from "./fixtures/journal/1628832338187636740.json" with { type: "json" };
import reply from "./fixtures/journal/1674865731136020505.json" with { type: "json" };
import plain from "./fixtures/journal/20.json" with { type: "json" };
import photo from "./fixtures/journal/463440424141459456.json" with { type: "json" };

// Real syndication payloads captured from cdn.syndication.twimg.com, one per
// content shape the feed must handle.
const FIXTURES: Record<string, unknown> = {
  "1585341984679469056": video,
  "1599367266448994304": quote,
  "1623411400545632256": longPost,
  "1628832338187636740": linkCard,
  "1674865731136020505": reply,
  "20": plain,
  "463440424141459456": photo,
};

function fixture(id: string): unknown {
  const payload = FIXTURES[id];
  if (payload === undefined) throw new Error(`no fixture for ${id}`);
  return payload;
}

function snapshot(id: string): TweetSnapshot {
  const parsed = tweetSnapshotFromSyndication(id, fixture(id));
  if (!parsed) throw new Error(`fixture ${id} should hydrate`);
  return parsed;
}

test("tweet permalinks parse across hosts and trailing segments", (t) => {
  t.is(tweetIdFromUrl("https://x.com/jack/status/20"), "20");
  t.is(tweetIdFromUrl("https://twitter.com/jack/status/20?s=61&t=abc"), "20");
  t.is(tweetIdFromUrl("https://mobile.x.com/jack/status/20#photo"), "20");
  t.is(tweetIdFromUrl("https://www.twitter.com/a/statuses/123/photo/1"), "123");
  // The handle segment must precede /status/.
  t.is(tweetIdFromUrl("https://x.com/status/20"), null);
  t.is(tweetIdFromUrl("https://x.com/jack/status/20abc"), null);
  t.is(tweetIdFromUrl("https://example.com/jack/status/20"), null);
  t.is(tweetIdFromUrl("not a url"), null);
  t.is(tweetIdFromUrl("ftp://x.com/jack/status/20"), null);
});

test("the syndication token matches the widget derivation", (t) => {
  // ((20 / 1e15) * Math.PI).toString(36) with zeros and the radix point
  // removed — the value X's own embed code sends for this id.
  t.is(syndicationToken("20"), "6dq1a2xwd93");
});

test("a plain tweet hydrates author, text, and date", (t) => {
  const tweet = snapshot("20");
  t.is(tweet.author.handle, "jack");
  t.is(tweet.author.name, "jack");
  t.is(tweet.url, "https://x.com/jack/status/20");
  t.deepEqual(tweet.runs, [{ kind: "text", text: "just setting up my twttr" }]);
  t.false(tweet.partial);
  t.deepEqual(tweet.media, []);
  t.true(tweet.createdAt?.startsWith("2006-03-21"));
  t.true(tweet.author.avatarUrl?.startsWith("https://pbs.twimg.com/"));
  t.is(tweet.card, undefined);
});

test("engagement counts and verification come through", (t) => {
  const tweet = snapshot("20");
  t.is(tweet.likes, 309060);
  t.is(tweet.replies, 17999);
  t.is(tweet.author.verified, true);
  t.is(snapshot("1628832338187636740").author.verified, false);
});

test("t.co link entities expand into labeled link runs", (t) => {
  // The quoted tweet keeps its link inline (its own card is not this tweet's).
  const quoted = snapshot("1599367266448994304").quoted;
  t.truthy(quoted);
  const link = quoted?.runs.find((run) => run.kind === "link");
  t.truthy(link);
  t.true(link?.url?.startsWith("https://"));
  t.false(link?.url?.includes("t.co"));
  t.false(link?.text.includes("t.co"));
  t.true(quoted?.runs.every((run) => !run.text.includes("https://t.co")));
});

test("extracts link card data and removes trailing link url from body text", (t) => {
  const tweet = snapshot("1628832338187636740");
  const card = tweet.card;
  t.truthy(card);
  t.is(card?.domain, "nextjs.org");
  t.is(card?.title, "Next.js 13.2");
  t.truthy(card?.description);
  t.is(card?.large, true);
  t.true(card?.imageUrl?.startsWith("https://pbs.twimg.com/card_img/"));
  t.true(card?.url.startsWith("https://nextjs.org"));
  // The trailing t.co that produced the card no longer doubles as body text.
  t.true(tweet.runs.every((run) => run.url !== card?.url));
  t.false(tweet.runs[tweet.runs.length - 1]?.text.endsWith(" "));
});

test("reply context is captured", (t) => {
  const tweet = snapshot("1674865731136020505");
  t.is(tweet.replyTo?.handle, "xDaily");
  t.truthy(tweet.replyTo?.id);
});

test("photo media hydrates with dimensions and no dangling t.co", (t) => {
  const tweet = snapshot("463440424141459456");
  t.is(tweet.media.length, 1);
  t.is(tweet.media[0]?.kind, "photo");
  t.true(tweet.media[0]?.imageUrl.startsWith("https://pbs.twimg.com/media/"));
  t.true((tweet.media[0]?.width ?? 0) > 0);
  t.is(tweet.author.handle, "Interior");
  // The media's own t.co link is stripped from the text runs.
  t.true(tweet.runs.every((run) => !run.text.includes("t.co")));
  t.regex(tweet.runs[0]?.text ?? "", /Sunsets don't get much better/);
});

test("video media hydrates as a poster with a watch link", (t) => {
  const tweet = snapshot("1585341984679469056");
  t.is(tweet.media.length, 1);
  t.is(tweet.media[0]?.kind, "video");
  t.true(tweet.media[0]?.imageUrl.startsWith("https://pbs.twimg.com/"));
  t.true(tweet.media[0]?.watchUrl?.includes("/status/1585341984679469056"));
});

test("quote tweets nest with their own text, links, and media", (t) => {
  const tweet = snapshot("1599367266448994304");
  t.is(tweet.author.handle, "0xca0a");
  t.is(tweet.media[0]?.kind, "video");
  const quoted = tweet.quoted;
  t.truthy(quoted);
  t.is(quoted?.author.handle, "CantBeFaraz");
  t.is(quoted?.media[0]?.kind, "video");
  const quotedLinks = quoted?.runs.filter((run) => run.kind === "link") ?? [];
  t.true(quotedLinks.length >= 1);
  t.true(quotedLinks.every((run) => !run.url?.includes("t.co")));
  // Quote snapshots never recurse further.
  t.false("quoted" in (quoted ?? {}));
});

test("long posts are marked partial and get a trailing ellipsis", (t) => {
  const tweet = snapshot("1623411400545632256");
  t.true(tweet.partial);
  t.true(tweet.runs[tweet.runs.length - 1]?.text.endsWith("…"));
});

test("tombstoned and malformed payloads do not hydrate", (t) => {
  t.is(tweetSnapshotFromSyndication("1", { __typename: "TweetTombstone" }), null);
  t.is(tweetSnapshotFromSyndication("1", "nope"), null);
  t.is(tweetSnapshotFromSyndication("1", null), null);
  t.is(tweetSnapshotFromSyndication("1", { __typename: "Tweet" }), null);
  // A handle that would forge the permalink is not storable.
  t.is(
    tweetSnapshotFromSyndication("20", {
      __typename: "Tweet",
      id_str: "20",
      user: { screen_name: "evil/status/21/x" },
    }),
    null,
  );
});

test("a trailing permalink is presentation-only and an inline one is not", (t) => {
  const trailing = tweetReferences(
    "What does this look like? https://x.com/user/status/2097801834224312595\n",
  );
  t.is(trailing.length, 1);
  t.is(trailing[0]?.tweetId, "2097801834224312595");
  t.is(trailing[0]?.placement, "trailing");

  const inline = tweetReferences("See https://x.com/user/status/20 before this text.");
  t.is(inline.length, 1);
  t.is(inline[0]?.placement, "inline");
  t.is(inline[0]?.sourceUrl, "https://x.com/user/status/20");
});

test("every permalink in one trailing block is marked trailing", (t) => {
  const references = tweetReferences(
    "Compare:\nhttps://x.com/one/status/20\nhttps://x.com/two/status/21\n",
  );
  t.is(references.length, 2);
  t.true(references.every((reference) => reference.placement === "trailing"));
});

test("a repeated permalink is deduped and its last occurrence sets placement", (t) => {
  const deduped = tweetReferences(
    "See https://twitter.com/user/status/20 before this text https://x.com/user/status/20",
  );
  t.is(deduped.length, 1);
  t.is(deduped[0]?.placement, "trailing");
  t.is(deduped[0]?.sourceUrl, "https://x.com/user/status/20");

  const references = tweetReferences(
    "https://x.com/one/status/20 discussed with https://x.com/two/status/21, final: https://x.com/one/status/20",
  );
  t.is(references.length, 2);
  t.is(references[0]?.tweetId, "21");
  t.is(references[0]?.placement, "inline");
  t.is(references[1]?.tweetId, "20");
  t.is(references[1]?.placement, "trailing");
});

test("a permalink the message wraps in syntax or punctuation stays inline", (t) => {
  // The card replaces a trailing permalink, so only a URL with nothing after
  // it can hide: a markdown link, an autolink, and a sentence-final URL all
  // have text of the user's own after them.
  const placements = [
    "See [the post](https://x.com/u/status/20)",
    "Autolink <https://x.com/u/status/21>",
    "Sentence ends with https://x.com/u/status/22.",
  ].map((message) => tweetReferences(message)[0]);
  t.deepEqual(
    placements.map((reference) => reference?.placement),
    ["inline", "inline", "inline"],
  );
  // The sentence's punctuation is not part of the permalink.
  t.is(placements[2]?.sourceUrl, "https://x.com/u/status/22");
});

test("markdown code does not create tweet attachments", (t) => {
  t.deepEqual(
    tweetReferences("`https://x.com/one/status/20`\n\n```text\nhttps://x.com/two/status/21\n```"),
    [],
  );
});

test("at most four posts are embedded per message", (t) => {
  const message = Array.from(
    { length: MAX_TWEETS_PER_MESSAGE + 3 },
    (_, index) => `https://x.com/user/status/${index + 1}`,
  ).join(" and ");
  const references = tweetReferences(message);
  t.is(references.length, MAX_TWEETS_PER_MESSAGE);
  t.deepEqual(
    references.map((reference) => reference.tweetId),
    ["1", "2", "3", "4"],
  );
  // Only the last of them can be trailing, since text follows the rest.
  t.deepEqual(
    references.map((reference) => reference.placement),
    ["inline", "inline", "inline", "inline"],
  );
});

test("a fetched post resolves into an attachment and a failure classifies", (t) => {
  const reference = tweetReferences("https://x.com/jack/status/20")[0];
  t.truthy(reference);
  if (!reference) return;

  const resolved = tweetAttachmentFromFetch(
    reference,
    { ok: true, payload: fixture("20"), fetchedAt: 2 },
    1,
  );
  t.is(resolved.status, "resolved");
  t.is(resolved.schemaVersion, 1);
  t.is(resolved.provider, "xSyndication");
  t.is(resolved.placement, "trailing");
  t.is(resolved.attemptedAt, 1);
  t.is(resolved.fetchedAt, 2);
  t.is(resolved.tweet?.author.handle, "jack");
  t.is(resolved.failure, undefined);

  // A payload that cannot be normalized is unavailable, not an error.
  const tombstoned = tweetAttachmentFromFetch(
    reference,
    { ok: true, payload: { __typename: "TweetTombstone" }, fetchedAt: 2 },
    1,
  );
  t.is(tombstoned.status, "unavailable");
  t.is(tombstoned.failure, "invalidPayload");
  t.is(tombstoned.tweet, undefined);
  t.is(tombstoned.fetchedAt, undefined);

  t.is(tweetAttachmentFromFetch(reference, { ok: false, error: "boom" }, 1).failure, "network");
});

test("fetch errors map onto the stored failure taxonomy", (t) => {
  t.is(classifyTweetFetchFailure("request timed out after 5s"), "timeout");
  t.is(classifyTweetFetchFailure("Timeout"), "timeout");
  t.is(classifyTweetFetchFailure("HTTP 404"), "notFound");
  t.is(classifyTweetFetchFailure("Not Found"), "notFound");
  t.is(classifyTweetFetchFailure("connection refused"), "network");
});
