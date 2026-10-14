// Image attachments (`repos/images.ts`): the owner check and limits when a
// message names images, and the pending/attached lifecycle the sweep keeps.

import { MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES } from "@session/shared";
import test from "ava";

import { images, schema, trees } from "../src/index.js";

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

test("references are read from nodes, drafts and queued follow-ups", (t) => {
  const fixture = createFixture(t);
  const inNode = upload(fixture);
  const inDraft = upload(fixture);
  const inQueue = upload(fixture);
  upload(fixture);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "A question with an image", attachments: [images.toAttachment(inNode)] },
    agent: { model: "gemini-flash" },
  });
  fixture.db
    .insert(schema.researchDrafts)
    .values({
      id: "draft-1",
      userId: fixture.userId,
      workspaceId: fixture.workspaceId,
      prompt: "A draft",
      attachmentsJson: [images.toAttachment(inDraft)],
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  fixture.db
    .insert(schema.followupQueue)
    .values({
      id: "queued-1",
      treeId: detail.tree.id,
      headNodeId: detail.tree.rootNodeId,
      authorId: fixture.userId,
      messageJson: { text: "Queued", attachments: [images.toAttachment(inQueue)] },
      model: "gemini-flash",
      effort: null,
      position: 0,
      createdAt: 1,
      failedReason: null,
    })
    .run();
  t.deepEqual(
    [...images.referencedIds(fixture.db)].sort(),
    [inNode.id, inDraft.id, inQueue.id].sort(),
  );
});

test("the sweep deletes expired pending images and releases unreferenced ones", (t) => {
  const fixture = createFixture(t);
  const pending = upload(fixture);
  const attached = upload(fixture);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "Question", attachments: [images.toAttachment(attached)] },
    agent: { model: "gemini-flash" },
    status: "complete",
  });
  images.markAttached(fixture.db, [attached.id]);

  // Within the lifetime nothing is deleted.
  t.deepEqual(images.sweep(fixture.db, Date.now()), { deleted: 0, released: 0, attached: 0 });

  // A referenced image stays whatever its age; a pending one past its
  // lifetime goes.
  t.deepEqual(images.sweep(fixture.db, Date.now() + DAY + 1), {
    deleted: 1,
    released: 0,
    attached: 0,
  });
  t.is(images.get(fixture.db, fixture.userId, pending.id), null);
  t.truthy(images.get(fixture.db, fixture.userId, attached.id));

  // Removing the thread removes the reference; the sweep then releases a
  // young image to pending and deletes an old one.
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(images.sweep(fixture.db, Date.now()), { deleted: 0, released: 1, attached: 0 });
  t.is(images.get(fixture.db, fixture.userId, attached.id)?.attachedAt, null);
  t.deepEqual(images.sweep(fixture.db, Date.now() + DAY + 1), {
    deleted: 1,
    released: 0,
    attached: 0,
  });
  t.deepEqual(images.storagePaths(fixture.db), []);
});

test("the sweep marks a pending image that a message names", (t) => {
  const fixture = createFixture(t);
  const image = upload(fixture);
  // Written the way a caller that skipped `markAttached` would leave it.
  trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    type: "exchange",
    message: { text: "Look", attachments: [images.toAttachment(image)] },
    agent: { model: "gemini-flash" },
  });
  t.is(images.get(fixture.db, fixture.userId, image.id)?.attachedAt, null);
  t.deepEqual(images.sweep(fixture.db, Date.now() + DAY + 1), {
    deleted: 0,
    released: 0,
    attached: 1,
  });
  t.not(images.get(fixture.db, fixture.userId, image.id)?.attachedAt, null);
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
