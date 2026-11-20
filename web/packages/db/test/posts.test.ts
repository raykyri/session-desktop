// Notes and saved links (`repos/posts.ts`): admission, follow-up notes, and
// the edit ported from the desktop's `update_research_post`.

import type { ResearchTweetAttachment } from "@session/shared";
import { MAX_POST_TEXT_BYTES, postDefaultTitle } from "@session/shared";
import test from "ava";

import { highlights, images, posts, schema, trash, trees } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

const agent = { model: "gemini-flash" };

function note(fixture: ReturnType<typeof createFixture>, text: string) {
  return posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text,
    agent,
  });
}

function tweet(sourceUrl: string, tweetId: string): ResearchTweetAttachment {
  return {
    kind: "tweet",
    schemaVersion: 1,
    sourceUrl,
    tweetId,
    placement: "inline",
    provider: "xSyndication",
    status: "unavailable",
    attemptedAt: 1,
    failure: "timeout",
  };
}

test("a note is a post root titled by its first line, with its format from the text", (t) => {
  const fixture = createFixture(t);
  const text = note(fixture, "  \nFirst line of the note\nSecond line  ");
  const root = text.nodes[0];
  t.is(root?.type, "post");
  t.is(text.tree.title, "First line of the note");
  t.is(root?.type === "post" ? root.format : null, "text");
  t.is(root?.message?.text, "First line of the note\nSecond line");

  const link = note(fixture, "https://example.com/article");
  const linkRoot = link.nodes[0];
  t.is(linkRoot?.type === "post" ? linkRoot.format : null, "link");
  t.deepEqual(linkRoot?.type === "post" ? linkRoot.followUpAgent : null, {
    adapter: "gemini",
    model: "gemini-flash",
    effort: null,
  });
});

test("a note must have text and fit the limit", (t) => {
  const fixture = createFixture(t);
  t.throws(() => note(fixture, "  \n "), { message: "note cannot be empty" });
  t.throws(() => note(fixture, "x".repeat(MAX_POST_TEXT_BYTES + 1)), {
    message: `notes are limited to ${MAX_POST_TEXT_BYTES} bytes`,
  });
});

test("the derived title cuts a long first line at a word boundary", (t) => {
  const long = `${"word ".repeat(30)}end`;
  const title = postDefaultTitle(long);
  t.true(title.endsWith("…"));
  t.true([...title].length <= 80);
  t.false(title.slice(0, -1).endsWith(" "));
  t.is(postDefaultTitle(""), "Post");
  t.is(postDefaultTitle("x".repeat(100)), `${"x".repeat(79)}…`);
});

test("follow-up notes go under posts only and inherit the follow-up agent", (t) => {
  const fixture = createFixture(t);
  const detail = note(fixture, "A note");
  const child = posts.admitFollowUpNote(fixture.db, fixture.userId, detail.tree.rootNodeId, " Re ");
  t.is(child.type, "post");
  t.is(child.parentNodeId, detail.tree.rootNodeId);
  t.is(child.message?.text, "Re");
  t.is(child.type === "post" ? child.followUpAgent.model : null, "gemini-flash");

  const question = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "A question" },
    agent,
  });
  t.throws(
    () => posts.admitFollowUpNote(fixture.db, fixture.userId, question.tree.rootNodeId, "note"),
    { message: /only notes take follow-up notes/ },
  );
  t.throws(() => posts.admitFollowUpNote(fixture.db, fixture.userId, detail.tree.rootNodeId, ""), {
    message: "note cannot be empty",
  });
});

test("an edit replaces the text, marks it edited, and the derived title follows", (t) => {
  const fixture = createFixture(t);
  const detail = note(fixture, "Old title\nbody");
  const result = posts.updatePost(fixture.db, fixture.userId, {
    nodeId: detail.tree.rootNodeId,
    text: "New title\nbody",
    expectedText: "Old title\nbody",
  });
  t.is(result.node.message?.text, "New title\nbody");
  t.truthy(result.node.type === "post" ? result.node.editedAt : null);
  t.is(result.tree.title, "New title");
  t.true(result.titleChanged);
  t.true(result.tree.updatedAt > detail.tree.updatedAt);

  // A renamed thread keeps its name through an edit.
  trees.rename(fixture.db, fixture.userId, detail.tree.id, "Chosen name");
  const renamed = posts.updatePost(fixture.db, fixture.userId, {
    nodeId: detail.tree.rootNodeId,
    text: "https://example.com/",
    expectedText: "New title\nbody",
  });
  t.is(renamed.tree.title, "Chosen name");
  t.false(renamed.titleChanged);
  t.is(renamed.node.type === "post" ? renamed.node.format : null, "link");

  // A follow-up note's text does not name the thread.
  const child = posts.admitFollowUpNote(
    fixture.db,
    fixture.userId,
    detail.tree.rootNodeId,
    "Reply",
  );
  const edited = posts.updatePost(fixture.db, fixture.userId, {
    nodeId: child.id,
    text: "Reply, edited",
    expectedText: "Reply",
  });
  t.is(edited.tree.title, "Chosen name");
});

test("an edit is refused on stale, unchanged or empty text", (t) => {
  const fixture = createFixture(t);
  const detail = note(fixture, "Text");
  const nodeId = detail.tree.rootNodeId;
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, {
        nodeId,
        text: "Mine",
        expectedText: "Something else",
      }),
    { message: "the note changed while you were editing; reopen the editor and try again" },
  );
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, {
        nodeId,
        text: " Text ",
        expectedText: "Text",
      }),
    { message: "the note's text is unchanged" },
  );
  t.throws(
    () => posts.updatePost(fixture.db, fixture.userId, { nodeId, text: " ", expectedText: "Text" }),
    { message: "the note cannot be empty" },
  );
});

test("an edit is refused for a question, an archived thread and another account", (t) => {
  const fixture = createFixture(t);
  const question = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "Question" },
    agent,
  });
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, {
        nodeId: question.tree.rootNodeId,
        text: "Edited",
        expectedText: "Question",
      }),
    { message: "only a note can be edited" },
  );
  const detail = note(fixture, "Text");
  const other = addUser(fixture.db, "other-poster");
  t.throws(
    () =>
      posts.updatePost(fixture.db, other.userId, {
        nodeId: detail.tree.rootNodeId,
        text: "Mine",
        expectedText: "Text",
      }),
    { message: `research node ${detail.tree.rootNodeId} was not found` },
  );
  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, {
        nodeId: detail.tree.rootNodeId,
        text: "Edited",
        expectedText: "Text",
      }),
    { message: "restore archived research before editing its note" },
  );
});

test("an edit keeps the link an attached X post was captured from", (t) => {
  const fixture = createFixture(t);
  const url = "https://x.com/session/status/1599367266448994304";
  const detail = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: url,
    attachments: [tweet(url, "1599367266448994304")],
    agent,
  });
  const nodeId = detail.tree.rootNodeId;
  t.throws(
    () => posts.updatePost(fixture.db, fixture.userId, { nodeId, text: "gone", expectedText: url }),
    { message: `keep the link ${url} in the text: the attached X post was captured from it` },
  );
  const kept = posts.updatePost(fixture.db, fixture.userId, {
    nodeId,
    text: `Worth reading: ${url}`,
    expectedText: url,
  });
  t.is(kept.node.message?.attachments?.length, 1);
  t.is(kept.node.type === "post" ? kept.node.format : null, "text");
});

test("an edit moves highlights to their quote and removes the ones whose quote is gone", (t) => {
  const fixture = createFixture(t);
  const text = "Alpha paragraph here.\n\nBeta paragraph there.";
  const detail = note(fixture, text);
  const nodeId = detail.tree.rootNodeId;
  // Highlights on a post are written directly: `highlights.create` requires
  // an answer snapshot, which a post does not have.
  const insert = (id: string, exact: string) => {
    const start = text.indexOf(exact);
    fixture.db
      .insert(schema.highlights)
      .values({
        id,
        authorId: fixture.userId,
        nodeId,
        anchorJson: {
          version: 1,
          projection: "answer-v1",
          responseRevision: "a".repeat(64),
          start,
          end: start + exact.length,
          exact,
          prefix: "",
          suffix: "",
        },
        responseRevision: "a".repeat(64),
        createdAt: 1,
      })
      .run();
  };
  insert("h-alpha", "Alpha paragraph");
  insert("h-beta", "Beta paragraph");

  const result = posts.updatePost(fixture.db, fixture.userId, {
    nodeId,
    text: "Inserted first.\n\nBeta paragraph there.",
    expectedText: text,
  });
  t.is(result.removedHighlightCount, 1);
  const kept = highlights.listForNode(fixture.db, fixture.userId, nodeId);
  t.deepEqual(
    kept.map((highlight) => highlight.id),
    ["h-beta"],
  );
  const moved = kept[0]?.anchor;
  t.is(moved?.start, "Inserted first.\n\n".length);
  t.is(moved?.end, "Inserted first.\n\n".length + "Beta paragraph".length);
  t.deepEqual(
    result.node.highlights.map((highlight) => highlight.id),
    ["h-beta"],
  );
});

test("replacing tweet attachments keeps the other attachments and the order", (t) => {
  const fixture = createFixture(t);
  const url = "https://x.com/session/status/1599367266448994304";
  const detail = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: url,
    attachments: [tweet(url, "1599367266448994304")],
    agent,
  });
  const resolved: ResearchTweetAttachment = {
    ...tweet(url, "1599367266448994304"),
    status: "resolved",
    provider: "xOembed",
    fetchedAt: 2,
  };
  delete resolved.failure;
  const node = posts.replaceTweetAttachments(fixture.db, fixture.userId, detail.tree.rootNodeId, [
    resolved,
  ]);
  t.deepEqual(node.message?.attachments, [resolved]);
});

test("a note's images are marked attached when it is written", (t) => {
  const fixture = createFixture(t);
  const image = images.create(fixture.db, fixture.userId, {
    sha256: "f".repeat(64),
    mime: "image/png",
    byteSize: 10,
    width: null,
    height: null,
    fileName: null,
    storagePath: "/data/documents/f",
  });
  const detail = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: "A screenshot",
    attachments: [images.toAttachment(image)],
    agent,
  });
  t.deepEqual(detail.nodes[0]?.message?.attachments, [images.toAttachment(image)]);
  t.not(images.get(fixture.db, fixture.userId, image.id)?.attachedAt, null);
});

test("a note in the Trash takes no edit, follow-up note or tweet refresh", (t) => {
  const fixture = createFixture(t);
  const detail = note(fixture, "Text");
  const nodeId = detail.tree.rootNodeId;
  trash.trashTree(fixture.db, fixture.userId, detail.tree.id);
  const refusal = { message: "restore this research from the Trash before changing it" };
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, { nodeId, text: "New", expectedText: "Text" }),
    refusal,
  );
  t.throws(() => posts.admitFollowUpNote(fixture.db, fixture.userId, nodeId, "Reply"), refusal);
  t.throws(() => posts.replaceTweetAttachments(fixture.db, fixture.userId, nodeId, []), refusal);
  // Another account is told the note does not exist, not that it is trashed.
  const other = addUser(fixture.db, "trash-reader");
  t.throws(() => posts.admitFollowUpNote(fixture.db, other.userId, nodeId, "Reply"), {
    message: `research node ${nodeId} was not found`,
  });
});
