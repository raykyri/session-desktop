// The tweet pipeline end to end: the two providers, the attachments a research
// question carries, and the embed asset cache behind their images
// (`03-api-and-events.md` §2, `13-deployment-fly.md` §6).

import { readFileSync } from "node:fs";

import { embeds, tweets } from "@session/db";
import test from "ava";

import {
  EMBED_PATH_PREFIX,
  embedHash,
  embedStoragePath,
  sweepEmbeds,
} from "../src/embeds/storage.js";
import { resolveMessageAttachments } from "../src/journal/attachments.js";
import { oembedRequestUrl, tweetSnapshotFromOembed } from "../src/journal/oembed.js";
import { resolveTweet } from "../src/journal/tweets.js";
import { researchUserText } from "../src/runs/prompts.js";

import { createHarness } from "./helpers.js";

const TWEET_ID = "1599367266448994304";
const TWEET_URL = `https://x.com/session/status/${TWEET_ID}`;
const AVATAR = "https://pbs.twimg.com/profile_images/1/avatar.jpg";
const PHOTO = "https://pbs.twimg.com/media/photo.jpg";

const SYNDICATION_PAYLOAD = {
  __typename: "Tweet",
  id_str: TWEET_ID,
  text: "A post about bloom filters",
  created_at: "2022-12-04T00:00:00.000Z",
  favorite_count: 3,
  user: {
    screen_name: "session",
    name: "Session",
    is_blue_verified: true,
    profile_image_url_https: AVATAR,
  },
  mediaDetails: [
    {
      type: "photo",
      media_url_https: PHOTO,
      original_info: { width: 1200, height: 675 },
    },
  ],
};

const OEMBED_HTML =
  '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my ' +
  '<a href="https://t.co/abc">twttr</a></p>&mdash; Session (@session) ' +
  `<a href="https://twitter.com/session/status/${TWEET_ID}?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>`;

const OEMBED_PAYLOAD = {
  html: OEMBED_HTML,
  author_name: "Session",
  author_url: "https://twitter.com/session",
  url: TWEET_URL,
};

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

interface RouteOptions {
  /** HTTP status the syndication CDN answers with. */
  syndication?: number;
  /** Body the syndication CDN answers with, when it answers 200. */
  syndicationBody?: unknown;
  oembed?: number;
  image?: number;
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A network that answers as the three upstreams do, recording every call. */
function routedFetch(log: string[], options: RouteOptions = {}): typeof globalThis.fetch {
  return (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = requestUrl(input);
    log.push(url);
    if (url.startsWith("https://cdn.syndication.twimg.com/")) {
      const status = options.syndication ?? 200;
      return Promise.resolve(
        new Response(
          status === 200 ? JSON.stringify(options.syndicationBody ?? SYNDICATION_PAYLOAD) : "no",
          { status, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.startsWith("https://publish.twitter.com/oembed")) {
      const status = options.oembed ?? 200;
      return Promise.resolve(
        new Response(status === 200 ? JSON.stringify(OEMBED_PAYLOAD) : "no", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.startsWith("https://pbs.twimg.com/")) {
      const status = options.image ?? 200;
      return Promise.resolve(
        new Response(status === 200 ? new Uint8Array(PNG) : null, {
          status,
          headers: { "Content-Type": "image/png" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

test("syndication answers first and its snapshot is the full one", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    TWEET_ID,
    { handle: "session" },
  );
  t.is(resolved.status, "resolved");
  t.is(resolved.provider, "xSyndication");
  t.is(resolved.snapshot?.author.handle, "session");
  t.is(resolved.snapshot?.media.length, 1);
  t.is(log.length, 1, "the fallback is not asked when the first provider answers");
  t.is(tweets.get(harness.db, TWEET_ID)?.provider, "xSyndication");
});

test("oEmbed is the fallback, and its snapshot is a reduced one", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log, { syndication: 404 }) });
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    TWEET_ID,
    { handle: "session" },
  );
  t.is(resolved.status, "resolved");
  t.is(resolved.provider, "xOembed");
  t.is(resolved.snapshot?.author.handle, "session");
  t.is(resolved.snapshot?.author.name, "Session");
  t.is(resolved.snapshot?.url, `https://x.com/session/status/${TWEET_ID}`);
  t.deepEqual(
    resolved.snapshot?.runs.map((run) => run.text),
    ["just setting up my ", "twttr"],
  );
  t.is(resolved.snapshot?.createdAt, "2006-03-21T00:00:00.000Z");
  t.deepEqual(resolved.snapshot?.media, [], "the endpoint returns no media");
  t.is(log.length, 2);
  t.true(log[1]?.startsWith("https://publish.twitter.com/oembed"));
});

test("a post neither provider serves is recorded as unavailable, once", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, {
    fetch: routedFetch(log, { syndication: 404, oembed: 404 }),
  });
  const deps = { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch };
  const resolved = await resolveTweet(deps, TWEET_ID);
  t.is(resolved.status, "unavailable");
  t.true(resolved.failure?.includes("404"));
  t.is(resolved.failureKind, "notFound");

  // The failure is cached too, so a card that is rendered again does not
  // re-ask both providers.
  const again = await resolveTweet(deps, TWEET_ID);
  t.true(again.cached);
  t.is(again.failureKind, "notFound");
  t.is(log.length, 2);
});

test("a syndication timeout does not spend a second request on the fallback", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, {
    fetch: (input) => {
      log.push(requestUrl(input));
      return Promise.reject(new Error("The operation was aborted due to timeout"));
    },
  });
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    TWEET_ID,
  );
  t.is(resolved.status, "unavailable");
  t.is(resolved.failureKind, "timeout");
  // A timeout means the path to X is slow or blocked, not that this post is
  // one syndication will not serve, so the caller waits once and retries.
  t.is(log.length, 1);
  t.true(log[0]?.startsWith("https://cdn.syndication.twimg.com/"));
});

test("a tombstone is an answer, not a transport failure", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, {
    fetch: routedFetch(log, {
      syndicationBody: { __typename: "TweetTombstone", tombstone: { text: "gone" } },
      oembed: 404,
    }),
  });
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    TWEET_ID,
  );
  t.is(resolved.status, "unavailable");
  t.is(resolved.failureKind, "invalidPayload");
});

test("an id that is not a status id is answered without asking either provider", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  // `journal.restore` hands back a whole entry the client was holding, so the
  // id reaching hydration is not always one this server derived.
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    "20; drop table",
  );
  t.is(resolved.status, "unavailable");
  t.is(log.length, 0);
});

test("the oEmbed request URL is built from the id, never from the caller", (t) => {
  t.is(
    oembedRequestUrl("20", "jack"),
    "https://publish.twitter.com/oembed?url=https%3A%2F%2Ftwitter.com%2Fjack%2Fstatus%2F20&omit_script=1&dnt=1&lang=en",
  );
  // A handle that is not handle-shaped falls back to X's own handle-less form
  // rather than reaching the endpoint.
  t.true(
    oembedRequestUrl("20", "../../evil?x=1").includes(
      "url=https%3A%2F%2Ftwitter.com%2Fi%2Fstatus%2F20",
    ),
  );
});

test("an oEmbed body that is not a post does not become one", async (t) => {
  t.is(await tweetSnapshotFromOembed("20", {}), null);
  t.is(await tweetSnapshotFromOembed("20", { html: OEMBED_HTML }), null, "no author");
  t.is(
    await tweetSnapshotFromOembed("20", { ...OEMBED_PAYLOAD, author_url: "https://x.com/" }),
    null,
    "no handle in the author URL",
  );
});

test("a question's permalinks become attachments on its node", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const user = harness.addUser("researcher");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();

  const prompt = `What is this claim about? ${TWEET_URL}`;
  const detail = await caller.research.createTree({
    prompt,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const root = detail.nodes[0];
  t.is(root?.prompt, prompt, "the stored question keeps the author's own text");
  t.is(root?.attachments?.length, 1);
  const attachment = root?.attachments?.[0];
  t.is(attachment?.status, "resolved");
  t.is(attachment?.provider, "xSyndication");
  t.is(attachment?.placement, "trailing");
  t.is(attachment?.tweetId, TWEET_ID);
  t.is(attachment?.tweet?.author.handle, "session");

  // The feed reads the same snapshot, so the Home card renders the post
  // without a second lookup.
  const feed = await caller.feed.recentActivity({ scope: "mine" });
  const item = feed.items.find((entry) => entry.kind === "research-query");
  t.is(
    item?.kind === "research-query" ? item.query.attachments?.[0]?.tweet?.author.handle : null,
    "session",
  );

  // And the run reads the post, not just the URL: the snapshot rides into the
  // request as explicitly untrusted reference material (`04` §5).
  const text = researchUserText({ node: root ?? { prompt, attachments: [], queryAnchor: null } });
  t.true(text.startsWith(prompt));
  t.true(text.includes("<session_reference_material>"));
  t.true(text.includes("untrusted reference material"));
  t.true(text.includes("A post about bloom filters"));
});

test("a follow-up resolves its own permalinks, and a repeat is served from the cache", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const deps = { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch };

  const first = await resolveMessageAttachments(deps, `Look at ${TWEET_URL}`);
  t.is(first.length, 1);
  const second = await resolveMessageAttachments(deps, `And again ${TWEET_URL}`);
  t.is(second[0]?.status, "resolved");
  t.is(log.length, 1, "the second question reads `tweet_cache`");
});

test("a message with no permalink never reaches the network", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const resolved = await resolveMessageAttachments(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    "What is a bloom filter?",
  );
  t.deepEqual(resolved, []);
  t.is(log.length, 0);
});

test("a provider that will not answer in time leaves the permalink readable", async (t) => {
  const harness = createHarness(t, {
    fetch: () => new Promise<Response>(() => undefined),
  });
  const resolved = await resolveMessageAttachments(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    `Look at ${TWEET_URL}`,
    20,
  );
  t.is(resolved.length, 1);
  t.is(resolved[0]?.status, "unavailable");
  t.is(resolved[0]?.failure, "timeout");
  t.is(resolved[0]?.tweet, undefined);
});

test("a stored snapshot points at this origin, and the bytes arrive on first render", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const resolved = await resolveTweet(
    { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch },
    TWEET_ID,
  );
  const avatarHash = embedHash(AVATAR);
  t.is(resolved.snapshot?.author.avatarUrl, `${EMBED_PATH_PREFIX}${avatarHash}`);
  t.is(resolved.snapshot?.media[0]?.imageUrl, `${EMBED_PATH_PREFIX}${embedHash(PHOTO)}`);
  // Registered, but nothing is fetched until a reader asks for it.
  t.is(embeds.get(harness.db, avatarHash)?.storedAt, null);
  t.is(log.length, 1);

  const first = await harness.request(`/embeds/${avatarHash}`);
  t.is(first.status, 200);
  t.is(first.headers.get("content-type"), "image/png");
  t.is(Buffer.from(await first.arrayBuffer()).byteLength, PNG.byteLength);
  t.is(embeds.get(harness.db, avatarHash)?.bytes, PNG.byteLength);
  t.is(log.length, 2);

  // The second read is the file on the volume.
  const second = await harness.request(`/embeds/${avatarHash}`);
  t.is(second.status, 200);
  t.is(log.length, 2);
  t.is(
    readFileSync(embedStoragePath(harness.config.embedsDir, avatarHash)).byteLength,
    PNG.byteLength,
  );
});

test("an unregistered hash, a malformed one, and a refusing origin are all 404", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log, { image: 403 }) });
  t.is((await harness.request("/embeds/not-a-hash")).status, 404);
  t.is((await harness.request(`/embeds/${"a".repeat(64)}`)).status, 404);

  await resolveTweet({ db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch }, TWEET_ID);
  const response = await harness.request(`/embeds/${embedHash(AVATAR)}`);
  t.is(response.status, 404, "an origin that will not serve the image is not an error page");
});

test("the sweep frees the volume and a later read re-fetches", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const deps = { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch };
  await resolveTweet(deps, TWEET_ID);
  const avatarHash = embedHash(AVATAR);
  await harness.request(`/embeds/${avatarHash}`);
  t.is(embeds.storedBytes(harness.db), PNG.byteLength);

  const swept = await sweepEmbeds({
    db: harness.db,
    embedsDir: harness.config.embedsDir,
    fetch: deps.fetch,
    // Nothing fits, so everything stored is evicted.
    maxBytes: 0,
  });
  t.is(swept.evicted, 1);
  t.is(swept.freedBytes, PNG.byteLength);
  t.is(embeds.storedBytes(harness.db), 0);
  t.truthy(embeds.get(harness.db, avatarHash), "the mapping outlives the bytes");

  const again = await harness.request(`/embeds/${avatarHash}`);
  t.is(again.status, 200);
  t.is(log.length, 3, "the evicted asset is fetched again rather than lost");
});

test("an asset nothing has asked for in long enough is evicted and then forgotten", async (t) => {
  const log: string[] = [];
  const harness = createHarness(t, { fetch: routedFetch(log) });
  const deps = { db: harness.db, fetch: harness.deps.fetch ?? globalThis.fetch };
  await resolveTweet(deps, TWEET_ID);
  const avatarHash = embedHash(AVATAR);
  await harness.request(`/embeds/${avatarHash}`);

  // A second past every access time, with no idle grace: the cache fits its
  // cap, so idleness is the only reason anything is evicted.
  const later = Date.now() + 1_000;
  const idle = await sweepEmbeds({
    db: harness.db,
    embedsDir: harness.config.embedsDir,
    fetch: deps.fetch,
    maxBytes: 1024 * 1024,
    maxIdleMs: 0,
    // The row is still fresh, so only the bytes go this time.
    rowMaxIdleMs: 60_000,
    now: later,
  });
  t.is(idle.evicted, 1);
  t.is(idle.prunedRows, 0);
  t.truthy(embeds.get(harness.db, avatarHash));

  const forgotten = await sweepEmbeds({
    db: harness.db,
    embedsDir: harness.config.embedsDir,
    fetch: deps.fetch,
    maxBytes: 1024 * 1024,
    rowMaxIdleMs: 0,
    now: later,
  });
  t.is(forgotten.prunedRows, 2, "the avatar and the photo");
  t.is(embeds.get(harness.db, avatarHash), null);
});
