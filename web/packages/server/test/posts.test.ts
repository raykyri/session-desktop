// Notes and saved links over tRPC (`research.createPost`,
// `createPostFollowUp`, `updatePost`, `hydratePostTweet`): link posts resolve
// their X post through syndication or the oEmbed fallback with cached embed
// images, and every change announces itself the way the desktop does.

import { embeds, images } from "@session/db";
import type { ResearchTweetAttachment, SessionEvent } from "@session/shared";
import { nodeAttachments } from "@session/shared/lib/researchNodeTypes";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { EMBED_PATH_PREFIX } from "../src/embeds/storage.js";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";

const TWEET_ID = "1599367266448994304";
const TWEET_URL = `https://x.com/session/status/${TWEET_ID}`;
const PHOTO = "https://pbs.twimg.com/media/photo.jpg";

const SYNDICATION_PAYLOAD = {
  __typename: "Tweet",
  id_str: TWEET_ID,
  text: "A post about bloom filters",
  created_at: "2022-12-04T00:00:00.000Z",
  user: {
    screen_name: "session",
    name: "Session",
    profile_image_url_https: "https://pbs.twimg.com/profile_images/1/avatar.jpg",
  },
  mediaDetails: [
    { type: "photo", media_url_https: PHOTO, original_info: { width: 1200, height: 675 } },
  ],
};

const OEMBED_PAYLOAD = {
  html:
    '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>' +
    `&mdash; Session (@session) <a href="https://twitter.com/session/status/${TWEET_ID}">March 21, 2006</a></blockquote>`,
  author_name: "Session",
  author_url: "https://twitter.com/session",
  url: TWEET_URL,
};

interface Upstream {
  syndication: number;
  oembed: number;
  calls: string[];
}

/** The two X endpoints, answering with the statuses in `upstream`, which a
 * test may change between calls. */
function upstreamFetch(upstream: Upstream): typeof globalThis.fetch {
  return (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    upstream.calls.push(url);
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(status === 200 ? JSON.stringify(body) : "no", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url.startsWith("https://cdn.syndication.twimg.com/")) {
      return json(upstream.syndication, SYNDICATION_PAYLOAD);
    }
    if (url.startsWith("https://publish.twitter.com/oembed")) {
      return json(upstream.oembed, OEMBED_PAYLOAD);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

function setup(t: Parameters<typeof createHarness>[0], upstream?: Partial<Upstream>) {
  const state: Upstream = { syndication: 200, oembed: 200, calls: [], ...upstream };
  const harness = createHarness(t, { fetch: upstreamFetch(state) });
  const user = harness.addUser("noter");
  const caller = harness.caller(user);
  return { harness, user, caller, upstream: state, events: recordEvents(harness) };
}

/** Every event published to one user's connections, in order. */
function recordEvents(harness: Harness): SessionEvent[] {
  const recorded: SessionEvent[] = [];
  const emit = harness.eventBus.emit.bind(harness.eventBus);
  harness.eventBus.emit = (userId, event) => {
    recorded.push(event);
    emit(userId, event);
  };
  return recorded;
}

function tweetOf(attachments: readonly unknown[]): ResearchTweetAttachment | undefined {
  return attachments.find(
    (attachment): attachment is ResearchTweetAttachment =>
      (attachment as { kind?: string }).kind === "tweet",
  );
}

test("a note becomes a post thread and announces it", async (t) => {
  const { caller, events } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "  A thought worth keeping\nwith a second line ",
    workspaceId: workspace.id,
    model: "gemini-flash",
    effort: "high",
  });
  const root = detail.nodes[0];
  t.is(root?.type, "post");
  t.is(detail.tree.title, "A thought worth keeping");
  t.deepEqual(root?.type === "post" ? root.followUpAgent : null, {
    adapter: "gemini",
    model: "gemini-flash",
    effort: "high",
  });
  // `feed.item.*` goes to every connection (`emitAll`), not through here.
  t.deepEqual(
    events.filter((event) => event.type.startsWith("research.")).map((event) => event.type),
    ["research.tree.created"],
  );
  t.deepEqual(events.find((event) => event.type === "research.tree.created")?.payload, {
    tree: detail.tree,
    node: root,
  });

  // A post has no run: nothing was queued.
  const listed = await caller.research.listTrees({ workspaceId: workspace.id });
  t.is(listed[0]?.type, "post");
  t.is(listed[0]?.runningCount, 0);
});

test("createPost refuses an unknown model, an unsupported effort and an empty note", async (t) => {
  const { caller } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const base = { body: "Note", workspaceId: workspace.id, model: "gemini-flash" };
  const unknown = await t.throwsAsync<TRPCError>(
    caller.research.createPost({ ...base, model: "no-such-model" }),
  );
  t.is(unknown?.code, "PRECONDITION_FAILED");
  const effort = await t.throwsAsync<TRPCError>(
    caller.research.createPost({ ...base, effort: "max" }),
  );
  t.is(effort?.code, "BAD_REQUEST");
  const empty = await t.throwsAsync<TRPCError>(
    caller.research.createPost({ ...base, body: "   " }),
  );
  t.is(empty?.code, "BAD_REQUEST");
  t.is(empty?.message, "note cannot be empty");
});

test("a link post resolves its X post and caches the post's images", async (t) => {
  const { harness, caller, upstream } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: TWEET_URL,
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const root = detail.nodes[0];
  t.is(root?.type === "post" ? root.format : null, "link");
  const attachment = tweetOf(root ? nodeAttachments(root) : []);
  t.is(attachment?.status, "resolved");
  t.is(attachment?.provider, "xSyndication");
  const photo = attachment?.tweet?.media[0]?.imageUrl ?? "";
  t.true(photo.startsWith(EMBED_PATH_PREFIX), "the image is served from this origin");
  t.truthy(embeds.get(harness.db, photo.slice(EMBED_PATH_PREFIX.length)));
  t.is(upstream.calls.length, 1);
});

test("a link post falls back to oEmbed when syndication refuses the post", async (t) => {
  const { caller, upstream } = setup(t, { syndication: 404 });
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: TWEET_URL,
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const attachment = tweetOf(detail.nodes[0] ? nodeAttachments(detail.nodes[0]) : []);
  t.is(attachment?.status, "resolved");
  t.is(attachment?.provider, "xOembed");
  t.is(attachment?.tweet?.author.handle, "session");
  t.is(upstream.calls.length, 2);
});

test("hydratePostTweet asks again for an unavailable post", async (t) => {
  const { caller, upstream, events } = setup(t, { syndication: 404, oembed: 404 });
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: TWEET_URL,
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;
  const before = tweetOf(detail.nodes[0] ? nodeAttachments(detail.nodes[0]) : []);
  t.is(before?.status, "unavailable");
  t.is(before?.failure, "notFound");

  // The cached failure is younger than the cache's lifetime; an explicit
  // retry asks the providers again regardless.
  upstream.syndication = 200;
  events.length = 0;
  const node = await caller.research.hydratePostTweet({ nodeId });
  const after = tweetOf(nodeAttachments(node));
  t.is(after?.status, "resolved");
  t.is(after?.failure, undefined);
  t.is(after?.sourceUrl, TWEET_URL);
  t.deepEqual(
    events.filter((event) => event.type.startsWith("research.")).map((event) => event.type),
    ["research.node.updated"],
  );

  // Nothing left to load: refused rather than refetched.
  const again = await t.throwsAsync<TRPCError>(caller.research.hydratePostTweet({ nodeId }));
  t.is(again?.code, "PRECONDITION_FAILED");
});

test("a follow-up note goes under a note and is announced as created", async (t) => {
  const { caller, events } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "A note",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  events.length = 0;
  const child = await caller.research.createPostFollowUp({
    parentNodeId: detail.tree.rootNodeId,
    body: "A reply",
  });
  t.is(child.type, "post");
  t.is(child.parentNodeId, detail.tree.rootNodeId);
  t.deepEqual(events.find((event) => event.type === "research.node.created")?.payload, {
    node: child,
  });

  const question = await caller.research.createTree({
    prompt: "A question",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const refused = await t.throwsAsync<TRPCError>(
    caller.research.createPostFollowUp({ parentNodeId: question.tree.rootNodeId, body: "note" }),
  );
  t.is(refused?.code, "BAD_REQUEST");
});

test("updatePost edits a note, follows the title and refuses stale text", async (t) => {
  const { caller, events } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "Old first line",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;
  events.length = 0;
  const result = await caller.research.updatePost({
    nodeId,
    text: "New first line",
    expectedText: "Old first line",
  });
  t.is(result.node.message?.text, "New first line");
  t.is(result.tree.title, "New first line");
  t.is(result.removedHighlightCount, 0);
  t.deepEqual(
    events.filter((event) => event.type.startsWith("research.")).map((event) => event.type),
    ["research.node.updated", "research.tree.updated"],
  );

  const stale = await t.throwsAsync<TRPCError>(
    caller.research.updatePost({ nodeId, text: "Mine", expectedText: "Old first line" }),
  );
  t.is(stale?.code, "CONFLICT");
  const unchanged = await t.throwsAsync<TRPCError>(
    caller.research.updatePost({ nodeId, text: "New first line", expectedText: "New first line" }),
  );
  t.is(unchanged?.code, "BAD_REQUEST");

  await caller.research.archiveTree({ treeId: detail.tree.id });
  const archived = await t.throwsAsync<TRPCError>(
    caller.research.updatePost({ nodeId, text: "Edit", expectedText: "New first line" }),
  );
  t.is(archived?.code, "PRECONDITION_FAILED");
});

test("a link post edit must keep the X post's link", async (t) => {
  const { caller } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: TWEET_URL,
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const refused = await t.throwsAsync<TRPCError>(
    caller.research.updatePost({
      nodeId: detail.tree.rootNodeId,
      text: "No link any more",
      expectedText: TWEET_URL,
    }),
  );
  t.is(refused?.code, "BAD_REQUEST");
  t.regex(refused?.message ?? "", /keep the link/);
});

test("another account's note is not found", async (t) => {
  const { harness, caller } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "Private note",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const stranger = harness.caller(harness.addUser("stranger"));
  const nodeId = detail.tree.rootNodeId;
  for (const attempt of [
    stranger.research.updatePost({ nodeId, text: "Mine", expectedText: "Private note" }),
    stranger.research.createPostFollowUp({ parentNodeId: nodeId, body: "Mine" }),
    stranger.research.hydratePostTweet({ nodeId }),
  ]) {
    const error = await t.throwsAsync<TRPCError>(attempt);
    t.is(error?.code, "NOT_FOUND");
  }
});

test("createPost attaches images the account uploaded", async (t) => {
  const { harness, caller, user } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const image = images.create(harness.db, user.id, {
    sha256: "e".repeat(64),
    mime: "image/png",
    byteSize: 10,
    width: 1,
    height: 1,
    fileName: "shot.png",
    storagePath: "/nonexistent/shot.png",
  });
  const detail = await caller.research.createPost({
    body: "A screenshot",
    workspaceId: workspace.id,
    model: "gemini-flash",
    images: [image.id],
  });
  t.deepEqual(detail.nodes[0]?.message?.attachments, [images.toAttachment(image)]);

  const stranger = harness.caller(harness.addUser("image-stranger"));
  const theirs = await stranger.workspaces.ensureDefault();
  const refused = await t.throwsAsync<TRPCError>(
    stranger.research.createPost({
      body: "Not mine",
      workspaceId: theirs.id,
      model: "gemini-flash",
      images: [image.id],
    }),
  );
  t.is(refused?.message, images.IMAGE_UNAVAILABLE);
});

test("notes in the Trash refuse changes with PRECONDITION_FAILED", async (t) => {
  const { caller } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createPost({
    body: "Trashed note",
    workspaceId: workspace.id,
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;
  await caller.research.trashTree({ treeId: detail.tree.id });
  for (const attempt of [
    caller.research.updatePost({ nodeId, text: "Edit", expectedText: "Trashed note" }),
    caller.research.createPostFollowUp({ parentNodeId: nodeId, body: "Reply" }),
  ]) {
    const error = await t.throwsAsync<TRPCError>(attempt);
    t.is(error?.code, "PRECONDITION_FAILED");
    t.is(error?.message, "restore this research from the Trash before changing it");
  }
});
