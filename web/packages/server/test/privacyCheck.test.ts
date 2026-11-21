// The privacy check of `04` P2 (`05` M6 exit criteria), run here against a
// temp database as the staging script runs it against the volume: after a
// removal the removed text is in neither the file nor its WAL, nor in any
// reader's snapshot or pull, nor in the author's notification.

import test from "ava";

import { privacyCheck } from "../src/ops/privacyCheck.js";

import { createHarness } from "./helpers.js";
import { channels, newId } from "./syncHttp.js";

const MARK = "PRIVACY-4c1e9b";

test("after a removal the check passes for the file, the WAL and every reader; before it, it finds the text", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open } = await channels(h);
  const th = newId();
  await mona.ok("threads.create", { id: th, space: open, kind: "post", q: `A post ${MARK}` });
  await mel.ok("research.createPostFollowUp", { id: newId(), thread: th, t: `A reply ${MARK}` });
  await mel.ok("saved.set", { kind: "thread", id: th, on: true });

  const input = {
    path: h.config.databasePath,
    thread: th,
    text: MARK,
    cursorKeys: h.config.sync.cursorKeys,
  };
  const before = privacyCheck(input);
  t.false(before.ok);
  t.true(before.checks.some((c) => !c.ok && c.name.startsWith("the text is not in")));
  t.true(before.checks.some((c) => !c.ok && c.name === "the thread is removed"));

  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Spam" });
  const after = privacyCheck(input);
  t.deepEqual(
    after.checks.filter((c) => !c.ok),
    [],
  );
  t.true(after.ok);
  const names = after.checks.map((c) => c.name);
  for (const who of [
    "the owner",
    "a member",
    "a non-member",
    "a signed-out reader",
    "the author",
  ]) {
    t.true(names.includes(`${who}'s snapshot holds no removed text`), who);
    t.true(names.includes(`${who}'s pull from before the removal holds no removed text`), who);
  }
  // the pulls were real pulls, not resyncs
  t.false(after.checks.some((c) => c.detail === "the pull answered resync"));
  t.true(names.includes("the removed notification holds no removed text"));
});
