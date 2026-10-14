// Image attachments (`repos/images.ts`): the owner check and limits when a
// message names images, the references (`image_refs`) every write path keeps,
// access through the thread that names an image, and the pending/attached
// lifecycle the sweep keeps.

import { MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES } from "@session/shared";
import test from "ava";
import { eq } from "drizzle-orm";

import {
  deletion,
  followups,
  images,
  nodes,
  researchDrafts,
  schema,
  sharing,
  trees,
  workspaces,
} from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

let counter = 0;

function upload(fixture: Fixture, options: { userId?: string; byteSize?: number } = {}) {
  counter += 1;
  return images.create(fixture.db, options.userId ?? fixture.userId, {
    sha256: String(counter).padStart(64, "0"),
    mime: "image/png",
    byteSize: options.byteSize ?? 100,
    width: 10,
    height: 20,
    fileName: `image-${counter}.png`,
    storagePath: `/data/documents/${options.userId ?? fixture.userId}/${counter}`,
  });
}

const DAY = images.PENDING_IMAGE_LIFETIME_MS;

test("resolving image ids keeps their order, drops duplicates and checks the owner", (t) => {
  const fixture = createFixture(t);
  const a = upload(fixture);
  const b = upload(fixture);
  const resolved = images.resolveAttachments(fixture.db, fixture.userId, [b.id, a.id, b.id]);
  t.deepEqual(
    resolved.map((attachment) => attachment.id),
    [b.id, a.id],
  );
  t.deepEqual(resolved[0], {
    kind: "image",
    id: b.id,
    mimeType: "image/png",
    byteSize: 100,
    width: 10,
    height: 20,
    fileName: b.fileName ?? "",
  });

  const other = addUser(fixture.db, "image-thief");
  t.throws(() => images.resolveAttachments(fixture.db, other.userId, [a.id]), {
    message: images.IMAGE_UNAVAILABLE,
  });
  t.throws(() => images.resolveAttachments(fixture.db, fixture.userId, ["missing"]), {
    message: images.IMAGE_UNAVAILABLE,
  });
});

test("a message carries at most 8 images and 20 MB of them", (t) => {
  const fixture = createFixture(t);
  const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => upload(fixture).id);
  t.throws(() => images.resolveAttachments(fixture.db, fixture.userId, many), {
    message: `A message can include up to ${MAX_IMAGES_PER_MESSAGE} images.`,
  });
  t.is(
    images.resolveAttachments(fixture.db, fixture.userId, many.slice(0, MAX_IMAGES_PER_MESSAGE))
      .length,
    MAX_IMAGES_PER_MESSAGE,
  );
  const big = [MAX_MESSAGE_IMAGE_BYTES / 2, MAX_MESSAGE_IMAGE_BYTES / 2 + 1].map(
    (byteSize) => upload(fixture, { byteSize }).id,
  );
  t.throws(() => images.resolveAttachments(fixture.db, fixture.userId, big), {
    message: "A message's images can total 20 MB at most.",
  });
});

/** A thread whose root question names `attached`, its answer complete. */
function threadWith(fixture: Fixture, attached: images.ImageRow[], status: "complete" | "running") {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "A question with images", attachments: attached.map(images.toAttachment) },
    agent: { model: "gemini-flash" },
    status,
  });
  return detail.tree;
}

/** Shares the thread with `member` as a commenter, through a link. */
function shareWith(fixture: Fixture, treeId: string, member: { userId: string; login: string }) {
  const link = sharing.createInvite(fixture.db, fixture.userId, { treeId, role: "commenter" });
  sharing.acceptInvite(
    fixture.db,
    { id: member.userId, login: member.login },
    { token: link.token },
  );
}

function refIds(fixture: Fixture, kind: images.ImageHolderKind, holderId: string): string[] {
  return images.refsOf(fixture.db, kind, holderId).map((ref) => ref.imageId);
}

function attachedAt(fixture: Fixture, image: images.ImageRow): number | null | undefined {
  return images.get(fixture.db, fixture.userId, image.id)?.attachedAt;
}

test("a root question and a follow-up reference their images; removing the branch drops them", (t) => {
  const fixture = createFixture(t);
  const inRoot = upload(fixture);
  const inFollowUp = upload(fixture);
  const tree = threadWith(fixture, [inRoot], "complete");
  t.deepEqual(refIds(fixture, "node", tree.rootNodeId), [inRoot.id]);
  t.is(images.refsOf(fixture.db, "node", tree.rootNodeId)[0]?.treeId, tree.id);
  t.not(attachedAt(fixture, inRoot), null, "writing the reference marks the image attached");

  const followUp = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "And this one?", attachments: [images.toAttachment(inFollowUp)] },
  });
  t.deepEqual(refIds(fixture, "node", followUp.id), [inFollowUp.id]);
  t.not(attachedAt(fixture, inFollowUp), null);

  nodes.setStatus(fixture.db, fixture.userId, followUp.id, "failed");
  nodes.removeBranch(fixture.db, fixture.userId, followUp.id);
  t.deepEqual(refIds(fixture, "node", followUp.id), []);
  t.is(attachedAt(fixture, inFollowUp), null, "its last reference gone, the image is pending");
  t.not(attachedAt(fixture, inRoot), null);
});

test("an edited question drops the replaced question's references", (t) => {
  const fixture = createFixture(t);
  const image = upload(fixture);
  const tree = threadWith(fixture, [], "complete");
  const failed = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Look", attachments: [images.toAttachment(image)] },
    inline: true,
  });
  nodes.setStatus(fixture.db, fixture.userId, failed.id, "failed");
  const edited = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Look again" },
    inline: true,
    replacesNodeId: failed.id,
  });
  t.deepEqual(refIds(fixture, "node", failed.id), []);
  t.deepEqual(refIds(fixture, "node", edited.id), []);
  t.is(attachedAt(fixture, image), null);
});

test("a queued follow-up references its images until it is sent, then its node does", (t) => {
  const fixture = createFixture(t);
  const image = upload(fixture);
  const tree = threadWith(fixture, [], "running");
  const queued = followups.ask(fixture.db, fixture.userId, {
    headNodeId: tree.rootNodeId,
    message: { text: "Queued", attachments: [images.toAttachment(image)] },
    agent: { model: "gemini-flash" },
  });
  if (queued.kind !== "queued") {
    t.fail("expected the follow-up to be queued");
    return;
  }
  t.deepEqual(refIds(fixture, "queue", queued.item.id), [image.id]);
  t.is(images.refsOf(fixture.db, "queue", queued.item.id)[0]?.treeId, tree.id);
  t.not(attachedAt(fixture, image), null);

  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const step = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  if (step.kind !== "send") {
    t.fail(`expected a send, got ${step.kind}`);
    return;
  }
  const sent = followups.send(fixture.db, fixture.userId, step.item.id, step.tailId);
  t.deepEqual(refIds(fixture, "queue", queued.item.id), []);
  t.deepEqual(refIds(fixture, "node", sent.node.id), [image.id]);
  t.not(attachedAt(fixture, image), null, "the node's reference keeps it attached");
});

test("cancelling a queued follow-up, or its chain head going, drops its references", (t) => {
  const fixture = createFixture(t);
  const cancelled = upload(fixture);
  const cleared = upload(fixture);
  const tree = threadWith(fixture, [], "running");
  const ask = (image: images.ImageRow) => {
    const result = followups.ask(fixture.db, fixture.userId, {
      headNodeId: tree.rootNodeId,
      message: { text: "Queued", attachments: [images.toAttachment(image)] },
      agent: { model: "gemini-flash" },
    });
    if (result.kind !== "queued") throw new Error("expected the follow-up to be queued");
    return result.item;
  };
  const first = ask(cancelled);
  const second = ask(cleared);
  followups.cancel(fixture.db, fixture.userId, first.id);
  t.deepEqual(refIds(fixture, "queue", first.id), []);
  t.is(attachedAt(fixture, cancelled), null);

  t.is(followups.clear(fixture.db, tree.rootNodeId), 1);
  t.deepEqual(refIds(fixture, "queue", second.id), []);
  t.is(attachedAt(fixture, cleared), null);
});

test("a member's queued follow-ups lose their references when they leave", (t) => {
  const fixture = createFixture(t);
  const member = { ...addUser(fixture.db, "image-member"), login: "image-member" };
  const image = upload(fixture, { userId: member.userId });
  const tree = threadWith(fixture, [], "running");
  shareWith(fixture, tree.id, member);
  const result = followups.ask(fixture.db, member.userId, {
    headNodeId: tree.rootNodeId,
    message: { text: "Queued", attachments: [images.toAttachment(image)] },
    agent: { model: "gemini-flash" },
  });
  if (result.kind !== "queued") {
    t.fail("expected the follow-up to be queued");
    return;
  }
  t.deepEqual(refIds(fixture, "queue", result.item.id), [image.id]);
  sharing.leave(fixture.db, member.userId, tree.id);
  t.deepEqual(refIds(fixture, "queue", result.item.id), []);
  t.is(images.get(fixture.db, member.userId, image.id)?.attachedAt, null);
});

test("a draft's references follow its images and go when it is removed", (t) => {
  const fixture = createFixture(t);
  const first = upload(fixture);
  const second = upload(fixture);
  const draft = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Draft",
    images: [images.toAttachment(first)],
  });
  t.deepEqual(refIds(fixture, "draft", draft.id), [first.id]);
  t.is(images.refsOf(fixture.db, "draft", draft.id)[0]?.treeId, null);

  // Saved without images, the draft keeps them.
  researchDrafts.save(fixture.db, fixture.userId, {
    id: draft.id,
    workspaceId: fixture.workspaceId,
    prompt: "Draft, edited",
  });
  t.deepEqual(refIds(fixture, "draft", draft.id), [first.id]);

  // Given, they replace the draft's; the dropped one is released.
  researchDrafts.save(fixture.db, fixture.userId, {
    id: draft.id,
    workspaceId: fixture.workspaceId,
    prompt: "Draft, edited",
    images: [images.toAttachment(second)],
  });
  t.deepEqual(refIds(fixture, "draft", draft.id), [second.id]);
  t.is(attachedAt(fixture, first), null);
  t.not(attachedAt(fixture, second), null);

  researchDrafts.remove(fixture.db, fixture.userId, draft.id);
  t.deepEqual(refIds(fixture, "draft", draft.id), []);
  t.is(attachedAt(fixture, second), null);
});

test("an image another holder names stays attached when one holder goes", (t) => {
  const fixture = createFixture(t);
  const image = upload(fixture);
  const draft = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Draft",
    images: [images.toAttachment(image)],
  });
  threadWith(fixture, [image], "complete");
  researchDrafts.remove(fixture.db, fixture.userId, draft.id);
  t.not(attachedAt(fixture, image), null);
});

test("deleting a thread or removing a workspace drops its references", (t) => {
  const fixture = createFixture(t);
  const inThread = upload(fixture);
  const inDraft = upload(fixture);
  const inWorkspace = upload(fixture);
  const tree = threadWith(fixture, [inThread], "complete");
  trees.remove(fixture.db, fixture.userId, tree.id);
  // Hidden at once; the references go with the nodes, in the background.
  t.is(images.readable(fixture.db, null, inThread.id), null);
  deletion.drain(fixture.db);
  t.deepEqual(refIds(fixture, "node", tree.rootNodeId), []);
  t.is(attachedAt(fixture, inThread), null);

  const workspace = workspaces.create(fixture.db, fixture.userId, "Doomed");
  const draft = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: workspace.id,
    prompt: "Draft",
    images: [images.toAttachment(inDraft)],
  });
  const other = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: workspace.id,
    type: "exchange",
    message: { text: "Question", attachments: [images.toAttachment(inWorkspace)] },
    agent: { model: "gemini-flash" },
    status: "complete",
  });
  workspaces.remove(fixture.db, fixture.userId, workspace.id);
  t.deepEqual(refIds(fixture, "draft", draft.id), [], "the drafts go at once");
  t.is(attachedAt(fixture, inDraft), null);
  deletion.drain(fixture.db);
  t.deepEqual(refIds(fixture, "node", other.tree.rootNodeId), []);
  t.is(attachedAt(fixture, inWorkspace), null);
});

test("who may see an image goes through the thread that names it", (t) => {
  const fixture = createFixture(t);
  const image = upload(fixture);
  const inDraft = upload(fixture);
  const tree = threadWith(fixture, [image], "complete");
  researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Draft",
    images: [images.toAttachment(inDraft)],
  });
  const reader = { ...addUser(fixture.db, "image-reader"), login: "image-reader" };
  t.truthy(images.readable(fixture.db, fixture.userId, image.id), "the uploader");
  t.is(images.readable(fixture.db, reader.userId, image.id), null, "a stranger");
  t.is(images.readable(fixture.db, null, image.id), null, "a guest");

  shareWith(fixture, tree.id, reader);
  t.truthy(images.readable(fixture.db, reader.userId, image.id), "a member");
  t.is(images.readable(fixture.db, reader.userId, inDraft.id), null, "a draft is its owner's");

  sharing.setVisibility(fixture.db, fixture.userId, tree.id, "public");
  t.truthy(images.readable(fixture.db, null, image.id), "a guest of a public thread");

  trees.remove(fixture.db, fixture.userId, tree.id);
  t.is(images.readable(fixture.db, reader.userId, image.id), null, "a deleted thread");
  t.is(images.readable(fixture.db, null, image.id), null);
  t.truthy(images.readable(fixture.db, fixture.userId, image.id), "the uploader still");
});

test("the sweep deletes expired pending images and releases unreferenced ones", (t) => {
  const fixture = createFixture(t);
  const pending = upload(fixture);
  const attached = upload(fixture);
  const tree = threadWith(fixture, [attached], "complete");
  const none = { deleted: 0, released: 0, attached: 0, dangling: 0 };

  // Within the lifetime nothing is deleted.
  t.deepEqual(images.sweep(fixture.db, Date.now()), none);

  // A referenced image stays whatever its age; a pending one past its
  // lifetime goes.
  t.deepEqual(images.sweep(fixture.db, Date.now() + DAY + 1), { ...none, deleted: 1 });
  t.is(images.get(fixture.db, fixture.userId, pending.id), null);
  t.truthy(images.get(fixture.db, fixture.userId, attached.id));

  // Deleting the thread drops the reference and releases the image; the
  // sweep then deletes it once it is old enough.
  trees.remove(fixture.db, fixture.userId, tree.id);
  deletion.drain(fixture.db);
  t.is(images.get(fixture.db, fixture.userId, attached.id)?.attachedAt, null);
  t.deepEqual(images.sweep(fixture.db, Date.now()), none);
  t.deepEqual(images.sweep(fixture.db, Date.now() + DAY + 1), { ...none, deleted: 1 });
  t.deepEqual(images.storagePaths(fixture.db), []);
});

test("the sweep drops references whose holder is gone and corrects the column", (t) => {
  const fixture = createFixture(t);
  const orphaned = upload(fixture);
  const unmarked = upload(fixture);
  const tree = threadWith(fixture, [unmarked], "complete");
  // A reference left behind by a cascade the repositories did not see, and
  // an image written attached without its column set.
  fixture.db
    .insert(schema.imageRefs)
    .values({
      imageId: orphaned.id,
      holderKind: "draft",
      holderId: "gone",
      treeId: null,
      createdAt: 1,
    })
    .run();
  fixture.db
    .update(schema.researchImages)
    .set({ attachedAt: 1 })
    .where(eq(schema.researchImages.id, orphaned.id))
    .run();
  fixture.db
    .update(schema.researchImages)
    .set({ attachedAt: null })
    .where(eq(schema.researchImages.id, unmarked.id))
    .run();
  t.deepEqual(images.sweep(fixture.db, Date.now()), {
    deleted: 0,
    released: 1,
    attached: 1,
    dangling: 1,
  });
  t.is(attachedAt(fixture, orphaned), null);
  t.not(attachedAt(fixture, unmarked), null);
  t.deepEqual(refIds(fixture, "node", tree.rootNodeId), [unmarked.id]);
});

test("stored bytes sum an account's images", (t) => {
  const fixture = createFixture(t);
  upload(fixture, { byteSize: 300 });
  upload(fixture, { byteSize: 200 });
  const other = addUser(fixture.db, "other-uploader");
  upload(fixture, { userId: other.userId, byteSize: 50 });
  t.is(images.storedBytes(fixture.db, fixture.userId), 500);
  t.is(images.storedBytes(fixture.db, other.userId), 50);
});
