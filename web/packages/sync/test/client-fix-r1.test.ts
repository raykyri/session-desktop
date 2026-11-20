// The client half: regressions for phase 2's review, round 1 (reviewer B).
// A create whose answer was lost and whose text the person then changed is
// sent again as the same create (finding 2), and a record two logs hold is
// the newer copy when only the log read later has the change (the edge in
// the reviewer's notes).

import test from "ava";

import { NO_RESPONSE, type StoredRecord } from "../src/client/index.js";

import { client, inProcess, watched } from "./client-helpers.js";
import { cast, ok, type World } from "./helpers.js";

const threads = (w: World, space: string) =>
  [...w.server.records().values()].filter(
    (r) => r.kind === "thread" && (r as StoredRecord & { s: string }).s === space,
  ) as (StoredRecord & { id: string; q: string })[];

/** A client of mel on the web (`persist: false`) whose first write reaches
 * the server and applies, but whose answer is lost (`lose`), or never
 * reaches it. */
async function lossy(w: World, open: string, applies: boolean) {
  let first = true;
  const pushed = { n: 0 };
  const tr = watched(inProcess(w, "mel"), {
    push: async (es, next) => {
      pushed.n += es.length;
      if (!first) return next();
      first = false;
      if (applies) await next();
      return [NO_RESPONSE];
    },
  });
  const mel = client(w, "mel", { transport: tr, persist: false });
  await mel.init();
  await mel.open(`space:${open}`);
  return Object.assign(mel, { pushed });
}

test("finding 2: a create that applied but lost its answer, edited and sent again, is one thread", async (t) => {
  const { w, open } = cast(t);
  const mel = await lossy(w, open, true);
  const id = mel.newId();
  const input = { id, space: open, kind: "post", q: "first text" };
  const w1 = mel.write("threads.create", input);
  t.is(await w1.answer, null);
  t.is(mel.problems()[0]?.state, "failed");
  t.is(threads(w, open).length, 1);
  // the person changes the text and posts: the same create, not a new one
  t.true(mel.sendAgain(w1.local, { input: { ...input, q: "edited text" } }));
  await mel.flush();
  const e = mel.outbox().find((x) => x.local === w1.local);
  t.is(e?.state, "answered");
  t.is(threads(w, open).length, 1);
  // the thread holds what applied first
  t.is(threads(w, open)[0]?.q, "first text");
  t.is(threads(w, open)[0]?.id, id);
});

test("finding 2: a read that holds the thread answers the lost create: Send again finds nothing to send", async (t) => {
  const { w, open } = cast(t);
  const mel = await lossy(w, open, true);
  const id = mel.newId();
  const input = { id, space: open, kind: "post", q: "first text" };
  const w1 = mel.write("threads.create", input);
  t.is(await w1.answer, null);
  await mel.sync(`space:${open}`);
  // the replica holds the thread the create made: it applied
  const e = mel.outbox().find((x) => x.local === w1.local);
  t.true(e === undefined || e.state === "answered");
  const pushes = mel.pushed.n;
  t.false(mel.sendAgain(w1.local, { input: { ...input, q: "edited text" } }));
  await mel.flush();
  t.is(mel.pushed.n, pushes);
  t.is(threads(w, open).length, 1);
  t.is(threads(w, open)[0]?.q, "first text");
});

test("finding 2: a create that never reached the server, edited and sent again, applies the edit once", async (t) => {
  const { w, open } = cast(t);
  const mel = await lossy(w, open, false);
  const id = mel.newId();
  const input = { id, space: open, kind: "post", q: "first text" };
  const w1 = mel.write("threads.create", input);
  t.is(await w1.answer, null);
  t.is(threads(w, open).length, 0);
  t.true(mel.sendAgain(w1.local, { input: { ...input, q: "edited text" } }));
  await mel.flush();
  t.is(mel.outbox().find((x) => x.local === w1.local)?.state, "answered");
  t.is(threads(w, open).length, 1);
  t.is(threads(w, open)[0]?.q, "edited text");
  // the same id: the screen goes to the thread it named
  t.is(threads(w, open)[0]?.id, id);
  t.is((mel.outbox().find((x) => x.local === w1.local)?.input as { id: string }).id, id);
});

test("finding 2: Send again with an input that makes other ids changes nothing", async (t) => {
  const { w, open } = cast(t);
  const mel = await lossy(w, open, false);
  const input = { id: mel.newId(), space: open, kind: "post", q: "first text" };
  const w1 = mel.write("threads.create", input);
  t.is(await w1.answer, null);
  t.false(mel.sendAgain(w1.local, { input: { ...input, id: mel.newId(), q: "other" } }));
  t.false(mel.sendAgain(w1.local, { input: { ...input, kind: 3 } }));
  const e = mel.outbox().find((x) => x.local === w1.local);
  t.is(e?.state, "failed");
  t.deepEqual(e?.input, input);
  t.is(threads(w, open).length, 0);
});

test("the edge of review round 1: a record two logs hold is the newer copy when only the later log was read since", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  // the user log first, then the space's: both hold mel's member record
  await mel.open("user:mel");
  await mel.open(`space:${open}`);
  const key = `member:${open}:mel`;
  t.is((mel.get(key) as { role?: string } | undefined)?.role, "member");
  ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mel",
      role: "mod",
      base: { rev: w.rev(key) },
    }),
  );
  await mel.sync(`space:${open}`);
  t.is((mel.records("user:mel").get(key) as { role?: string } | undefined)?.role, "member");
  t.is((mel.confirmed(key) as { role?: string } | undefined)?.role, "mod");
  t.is((mel.get(key) as { role?: string } | undefined)?.role, "mod");
  // and the other way round: the user log read later
  ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mel",
      role: "member",
      base: { rev: w.rev(key) },
    }),
  );
  await mel.sync("user:mel");
  t.is((mel.get(key) as { role?: string } | undefined)?.role, "member");
});
