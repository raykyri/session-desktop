import { DEFAULT_USER_SETTINGS } from "@session/shared";
import test from "ava";

import { artifacts, documents, drafts, nodes, preferences, trees, tweets } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function upload(fixture: ReturnType<typeof createFixture>, sha256: string, name = "report.pdf") {
  return documents.create(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    name,
    mime: "application/pdf",
    byteSize: 1024,
    sha256,
    storagePath: `/data/documents/${fixture.userId}/${sha256}`,
  });
}

test("deduplicates identical document uploads by content hash", (t) => {
  const fixture = createFixture(t);
  const first = upload(fixture, "abc123");
  const second = upload(fixture, "abc123", "a-copy.pdf");
  t.is(second.id, first.id);
  t.is(documents.list(fixture.db, fixture.userId).length, 1);
  t.is(documents.totalBytes(fixture.db, fixture.userId), 1024);
});

test("extraction records pages and status together", (t) => {
  const fixture = createFixture(t);
  const document = upload(fixture, "abc123");
  t.is(document.extractionStatus, "pending");
  const extracted = documents.setExtraction(fixture.db, fixture.userId, document.id, {
    status: "ok",
    pages: ["page one", "page two"],
  });
  t.is(extracted.extractionStatus, "ok");
  t.is(extracted.pageCount, 2);
  t.deepEqual(documents.readText(fixture.db, fixture.userId, document.id), [
    "page one",
    "page two",
  ]);
  t.deepEqual(documents.readText(fixture.db, fixture.userId, document.id, 1), ["page two"]);
  t.deepEqual(documents.readText(fixture.db, "someone-else", document.id), []);
});

test("attached documents follow the node in display order", (t) => {
  const fixture = createFixture(t);
  const first = upload(fixture, "a".repeat(64), "one.pdf");
  const second = upload(fixture, "b".repeat(64), "two.pdf");
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "With attachments",
    model: "gemini-flash",
    documentIds: [second.id, first.id],
  });
  const root = nodes.get(fixture.db, fixture.userId, detail.tree.rootNodeId);
  t.deepEqual(root?.documentIds, [second.id, first.id]);
  documents.attach(fixture.db, fixture.userId, detail.tree.rootNodeId, [first.id]);
  t.deepEqual(
    documents.attachedTo(fixture.db, fixture.userId, detail.tree.rootNodeId).map((d) => d.id),
    [first.id],
  );
});

test("prevents deletion of documents referenced by research nodes", (t) => {
  const fixture = createFixture(t);
  const document = upload(fixture, "abc123");
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "With attachment",
    model: "gemini-flash",
    documentIds: [document.id],
  });
  t.throws(() => documents.remove(fixture.db, fixture.userId, document.id), {
    message: /currently attached to one or more research threads/,
  });
  documents.attach(fixture.db, fixture.userId, detail.tree.rootNodeId, []);
  // Document removal returns unreferenced storage paths for external filesystem deletion outside the database transaction.
  t.deepEqual(documents.remove(fixture.db, fixture.userId, document.id), {
    removed: true,
    orphanedPaths: [`/data/documents/${fixture.userId}/abc123`],
  });
  t.deepEqual(documents.remove(fixture.db, fixture.userId, document.id), {
    removed: false,
    orphanedPaths: [],
  });
});

test("an artifact token resolves once, expires, and never crosses accounts", (t) => {
  const fixture = createFixture(t);
  const document = upload(fixture, "abc123");
  const minted = artifacts.mintToken(fixture.db, fixture.userId, document.id, 60_000);
  const resolved = artifacts.resolveToken(fixture.db, minted.token);
  t.is(resolved?.documentId, document.id);
  t.is(resolved?.storagePath, `/data/documents/${fixture.userId}/abc123`);
  t.is(resolved?.userId, fixture.userId);
  t.is(artifacts.resolveToken(fixture.db, "not-a-token"), null);
  t.throws(() => artifacts.mintToken(fixture.db, "someone-else", document.id), {
    message: /was not found/,
  });

  fixture.db.$client
    .prepare(`UPDATE artifact_tokens SET expires_at = ? WHERE token = ?`)
    .run(Date.now() - 1, minted.token);
  t.is(artifacts.resolveToken(fixture.db, minted.token), null);
  t.is(artifacts.revokeExpired(fixture.db), 0, "the failed read already removed it");
});

test("drafts are per key and bounded", (t) => {
  const fixture = createFixture(t);
  t.is(drafts.get(fixture.db, fixture.userId, "composer"), null);
  drafts.set(fixture.db, fixture.userId, "composer", "half a question");
  drafts.set(fixture.db, fixture.userId, "composer", "a whole question");
  t.is(drafts.get(fixture.db, fixture.userId, "composer"), "a whole question");
  t.throws(() => drafts.set(fixture.db, fixture.userId, "k".repeat(200), "x"), {
    message: /Draft key exceeds maximum size/,
  });
  t.throws(
    () =>
      drafts.set(fixture.db, fixture.userId, "big", "x".repeat(drafts.MAX_DRAFT_VALUE_BYTES + 1)),
    { message: /Draft value exceeds maximum allowed size/ },
  );
  t.true(drafts.remove(fixture.db, fixture.userId, "composer"));
  t.false(drafts.remove(fixture.db, fixture.userId, "composer"));
});

test("preferences start at the defaults and merge field by field", (t) => {
  const fixture = createFixture(t);
  const initial = preferences.ensure(fixture.db, fixture.userId);
  t.deepEqual(initial.settings, DEFAULT_USER_SETTINGS);
  const updated = preferences.update(fixture.db, fixture.userId, {
    settings: { appearance: "light" },
    researchLaunchInstruction: "  Prefer primary sources.  ",
  });
  t.is(updated.settings.appearance, "light");
  t.is(updated.settings.defaultModel, DEFAULT_USER_SETTINGS.defaultModel);
  t.is(updated.researchLaunchInstruction, "Prefer primary sources.");
  t.is(
    preferences.update(fixture.db, fixture.userId, { researchLaunchInstruction: "   " })
      .researchLaunchInstruction,
    null,
  );
  t.throws(
    () =>
      preferences.update(fixture.db, fixture.userId, {
        researchLaunchInstruction: "x".repeat(
          preferences.MAX_RESEARCH_LAUNCH_INSTRUCTION_BYTES + 1,
        ),
      }),
    { message: /exceed maximum allowed size/ },
  );
});

test("the tweet cache stores a payload and its normalized snapshot", (t) => {
  const fixture = createFixture(t);
  t.is(tweets.get(fixture.db, "12345"), null);
  tweets.put(fixture.db, {
    tweetId: "12345",
    payload: { id_str: "12345" },
    snapshot: {
      id: "12345",
      url: "https://x.com/someone/status/12345",
      author: { name: "Someone", handle: "someone" },
      runs: [{ kind: "text", text: "hello" }],
      partial: false,
      media: [],
    },
    status: "resolved",
  });
  const cached = tweets.get(fixture.db, "12345");
  t.is(cached?.status, "resolved");
  t.is(cached?.snapshot?.author.handle, "someone");
  tweets.put(fixture.db, { tweetId: "12345", status: "unavailable", failure: "notFound" });
  t.is(tweets.get(fixture.db, "12345")?.snapshot, null);
  t.is(tweets.prune(fixture.db, Date.now() + 1000), 1);
});

test("a node from another account cannot be given attachments", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "documents-other");
  const theirs = trees.admitRoot(fixture.db, other.userId, {
    workspaceId: other.workspaceId,
    prompt: "Their question",
    model: "gemini-flash",
  });
  const document = upload(fixture, "cross-account");
  t.throws(
    () => documents.attach(fixture.db, fixture.userId, theirs.tree.rootNodeId, [document.id]),
    { message: /was not found/ },
  );
  t.deepEqual(documents.attachedTo(fixture.db, other.userId, theirs.tree.rootNodeId), []);
});

test("a document cannot be filed in another account's workspace", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "documents-workspace");
  t.throws(
    () =>
      documents.create(fixture.db, fixture.userId, {
        workspaceId: other.workspaceId,
        name: "report.pdf",
        mime: "application/pdf",
        byteSize: 1024,
        sha256: "foreign-workspace",
        storagePath: "/data/documents/x",
      }),
    { message: /workspace .* was not found/ },
  );
});
