// Saved research drafts (`repos/researchDrafts.ts`), after the desktop's
// `research_drafts_crud_reorder_emit_and_persist` (`state.rs`).

import type { ResearchImageAttachment } from "@session/shared";
import test from "ava";

import { images, researchDrafts, workspaces } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function upload(fixture: ReturnType<typeof createFixture>, name: string): ResearchImageAttachment {
  const row = images.create(fixture.db, fixture.userId, {
    sha256: name.padEnd(64, "0"),
    mime: "image/png",
    byteSize: 10,
    width: 1,
    height: 1,
    fileName: `${name}.png`,
    storagePath: `/tmp/${name}`,
  });
  return images.toAttachment(row);
}

test("a draft without an id goes to the top; with one it is edited in place", (t) => {
  const fixture = createFixture(t);
  const ids = () =>
    researchDrafts.list(fixture.db, fixture.userId, fixture.workspaceId).map((d) => d.prompt);
  t.throws(
    () =>
      researchDrafts.save(fixture.db, fixture.userId, {
        workspaceId: fixture.workspaceId,
        prompt: "  \n ",
      }),
    { message: "Research draft prompt cannot be empty." },
  );
  t.throws(
    () => researchDrafts.save(fixture.db, fixture.userId, { workspaceId: "missing", prompt: "Q" }),
    { message: "research workspace missing was not found" },
  );
  const first = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: " First question ",
  });
  t.is(first.prompt, "First question");
  t.is(first.attachments, undefined);
  researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Second question",
  });
  t.deepEqual(ids(), ["Second question", "First question"]);

  const edited = researchDrafts.save(fixture.db, fixture.userId, {
    id: first.id,
    workspaceId: fixture.workspaceId,
    prompt: "First, edited",
  });
  t.is(edited.id, first.id);
  t.is(edited.createdAt, first.createdAt);
  t.deepEqual(ids(), ["Second question", "First, edited"]);

  // A draft does not move to another workspace.
  const other = workspaces.create(fixture.db, fixture.userId, "Other");
  t.throws(
    () =>
      researchDrafts.save(fixture.db, fixture.userId, {
        id: first.id,
        workspaceId: other.id,
        prompt: "Moved",
      }),
    { message: `research draft ${first.id} was not found` },
  );
  t.deepEqual(researchDrafts.list(fixture.db, fixture.userId, other.id), []);
});

test("images are replaced only when given, and attaching marks them", (t) => {
  const fixture = createFixture(t);
  const a = upload(fixture, "a");
  const b = upload(fixture, "b");
  const draft = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "With an image",
    images: [a],
  });
  t.deepEqual(draft.attachments, [a]);
  t.not(images.get(fixture.db, fixture.userId, a.id)?.attachedAt, null);
  t.is(images.get(fixture.db, fixture.userId, b.id)?.attachedAt, null);

  const kept = researchDrafts.save(fixture.db, fixture.userId, {
    id: draft.id,
    workspaceId: fixture.workspaceId,
    prompt: "Text only changed",
  });
  t.deepEqual(kept.attachments, [a]);

  const replaced = researchDrafts.save(fixture.db, fixture.userId, {
    id: draft.id,
    workspaceId: fixture.workspaceId,
    prompt: "Image replaced",
    images: [b],
  });
  t.deepEqual(replaced.attachments, [b]);

  const cleared = researchDrafts.save(fixture.db, fixture.userId, {
    id: draft.id,
    workspaceId: fixture.workspaceId,
    prompt: "Images removed",
    images: [],
  });
  t.is(cleared.attachments, undefined);
});

test("reorder takes exactly the workspace's drafts and reports a change", (t) => {
  const fixture = createFixture(t);
  const save = (prompt: string) =>
    researchDrafts.save(fixture.db, fixture.userId, { workspaceId: fixture.workspaceId, prompt });
  const first = save("one");
  const second = save("two");
  const third = save("three");
  const other = workspaces.create(fixture.db, fixture.userId, "Other");
  const elsewhere = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: other.id,
    prompt: "elsewhere",
  });

  const unchanged = researchDrafts.reorder(fixture.db, fixture.userId, fixture.workspaceId, [
    third.id,
    second.id,
    first.id,
  ]);
  t.false(unchanged.changed);

  const result = researchDrafts.reorder(fixture.db, fixture.userId, fixture.workspaceId, [
    first.id,
    third.id,
    second.id,
  ]);
  t.true(result.changed);
  t.deepEqual(
    result.drafts.map((draft) => draft.prompt),
    ["one", "three", "two"],
  );
  // A new draft still goes to the top of the reordered list.
  save("four");
  t.deepEqual(
    researchDrafts.list(fixture.db, fixture.userId, fixture.workspaceId).map((d) => d.prompt),
    ["four", "one", "three", "two"],
  );

  const stale = [first.id, third.id];
  for (const draftIds of [
    stale,
    [...stale, second.id, second.id],
    [first.id, third.id, elsewhere.id],
  ]) {
    t.throws(
      () => researchDrafts.reorder(fixture.db, fixture.userId, fixture.workspaceId, draftIds),
      { message: researchDrafts.DRAFT_ORDER_STALE },
    );
  }
  t.deepEqual(
    researchDrafts.list(fixture.db, fixture.userId, other.id).map((d) => d.id),
    [elsewhere.id],
  );
});

test("drafts are private to the person who saved them", (t) => {
  const fixture = createFixture(t);
  const draft = researchDrafts.save(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Mine",
  });
  const other = addUser(fixture.db, "draft-reader");
  t.deepEqual(researchDrafts.list(fixture.db, other.userId, fixture.workspaceId), []);
  t.throws(() => researchDrafts.remove(fixture.db, other.userId, draft.id), {
    message: `research draft ${draft.id} was not found`,
  });
  t.throws(
    () =>
      researchDrafts.save(fixture.db, other.userId, {
        id: draft.id,
        workspaceId: fixture.workspaceId,
        prompt: "Theirs",
      }),
    { message: `research workspace ${fixture.workspaceId} was not found` },
  );
  t.deepEqual(researchDrafts.remove(fixture.db, fixture.userId, draft.id), {
    workspaceId: fixture.workspaceId,
  });
  t.deepEqual(researchDrafts.list(fixture.db, fixture.userId, fixture.workspaceId), []);
});
