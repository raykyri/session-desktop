// `drafts.*` (saved research drafts) over tRPC, and the
// `research.drafts.changed` event every draft change emits. The interface
// drafts (`interfaceDrafts.*`) are covered in `procedures.test.ts`.

import { images } from "@session/db";
import type { SessionEvent } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { createHarness } from "./helpers.js";

function setup(t: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(t);
  const user = harness.addUser("drafter");
  const events: { userId: string; event: SessionEvent }[] = [];
  const emit = harness.eventBus.emit.bind(harness.eventBus);
  harness.eventBus.emit = (userId, event) => {
    events.push({ userId, event });
    emit(userId, event);
  };
  return { harness, user, caller: harness.caller(user), events };
}

function draftEvents(events: { event: SessionEvent }[]) {
  return events
    .filter(({ event }) => event.type === "research.drafts.changed")
    .map(({ event }) => event.payload);
}

test("save, edit, reorder and remove a draft, each announced to its owner", async (t) => {
  const { caller, user, events } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const first = await caller.drafts.save({ workspaceId: workspace.id, prompt: "First" });
  const second = await caller.drafts.save({ workspaceId: workspace.id, prompt: "Second" });
  t.deepEqual(
    (await caller.drafts.list({ workspaceId: workspace.id })).map((draft) => draft.id),
    [second.id, first.id],
  );
  const edited = await caller.drafts.save({
    id: first.id,
    workspaceId: workspace.id,
    prompt: "First, edited",
  });
  t.is(edited.prompt, "First, edited");

  const reordered = await caller.drafts.reorder({
    workspaceId: workspace.id,
    draftIds: [first.id, second.id],
  });
  t.deepEqual(
    reordered.map((draft) => draft.id),
    [first.id, second.id],
  );
  // The same order again changes nothing and announces nothing.
  await caller.drafts.reorder({ workspaceId: workspace.id, draftIds: [first.id, second.id] });

  await caller.drafts.remove({ draftId: second.id });
  t.deepEqual(
    (await caller.drafts.list({ workspaceId: workspace.id })).map((draft) => draft.id),
    [first.id],
  );
  t.deepEqual(draftEvents(events), Array(5).fill({ workspaceId: workspace.id }));
  t.true(
    events
      .filter(({ event }) => event.type === "research.drafts.changed")
      .every(({ userId }) => userId === user.id),
  );
});

test("drafts refuse an empty prompt, a stale order and another account", async (t) => {
  const { harness, caller } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const empty = await t.throwsAsync<TRPCError>(
    caller.drafts.save({ workspaceId: workspace.id, prompt: "  " }),
  );
  t.is(empty?.code, "BAD_REQUEST");
  const draft = await caller.drafts.save({ workspaceId: workspace.id, prompt: "Mine" });
  const stale = await t.throwsAsync<TRPCError>(
    caller.drafts.reorder({ workspaceId: workspace.id, draftIds: [] }),
  );
  t.is(stale?.code, "CONFLICT");

  const stranger = harness.caller(harness.addUser("draft-stranger"));
  t.deepEqual(await stranger.drafts.list({ workspaceId: workspace.id }), []);
  for (const attempt of [
    stranger.drafts.remove({ draftId: draft.id }),
    stranger.drafts.save({ id: draft.id, workspaceId: workspace.id, prompt: "Theirs" }),
  ]) {
    t.is((await t.throwsAsync<TRPCError>(attempt))?.code, "NOT_FOUND");
  }
});

test("a draft's images are replaced only when given", async (t) => {
  const { harness, caller, user } = setup(t);
  const workspace = await caller.workspaces.ensureDefault();
  const image = images.create(harness.db, user.id, {
    sha256: "d".repeat(64),
    mime: "image/png",
    byteSize: 10,
    width: 1,
    height: 1,
    fileName: null,
    storagePath: "/nonexistent/d",
  });
  const draft = await caller.drafts.save({
    workspaceId: workspace.id,
    prompt: "Later",
    images: [image.id],
  });
  t.deepEqual(draft.attachments, [images.toAttachment(image)]);
  t.not(images.get(harness.db, user.id, image.id)?.attachedAt, null);
  const kept = await caller.drafts.save({
    id: draft.id,
    workspaceId: workspace.id,
    prompt: "Edit",
  });
  t.deepEqual(kept.attachments, draft.attachments);
  const cleared = await caller.drafts.save({
    id: draft.id,
    workspaceId: workspace.id,
    prompt: "Edit",
    images: [],
  });
  t.is(cleared.attachments, undefined);
  const missing = await t.throwsAsync<TRPCError>(
    caller.drafts.save({ workspaceId: workspace.id, prompt: "Gone", images: ["missing"] }),
  );
  t.is(missing?.message, images.IMAGE_UNAVAILABLE);
});
