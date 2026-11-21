// What the web client's event stream and thread addresses use (`01` Y7, R3;
// `02` §2.1): `receive` applies a pushed batch as a pull, `open(thread, log)`
// fetches a thread the replica does not hold from the log an address names,
// and `keysIn` reads an index with the predictions on top.

import { MUTATORS, threadKey } from "@session/mutators";
import test from "ava";

import { MemoryAdapter, SyncClient } from "../src/client/index.js";

import { DAY, World, cast, post } from "./world.js";

const client = (w: World, u: string) =>
  new SyncClient(w.transport(u), {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
  });

test("receive applies a pushed batch as a pull would, and is ignored for a log not held", async (t) => {
  const { w, open } = cast(t);
  const mona = client(w, "mona");
  const log = `space:${open}` as const;
  await mona.sync(log, "window");
  const id = post(t, w, "olga", open, "Pushed");
  const cursor = mona.cursor(log);
  if (!cursor) throw new Error("no cursor");
  const p = w.server.pull({ u: "mona" }, log, cursor);
  if ("resync" in p) throw new Error("resync");
  let heard = 0;
  mona.subscribe(() => heard++);
  t.true(await mona.receive(log, p));
  t.is(mona.get(threadKey(id))?.kind, "thread");
  t.is(mona.cursor(log), p.cursor);
  t.is(heard, 1);
  mona.dropLog(log);
  t.false(await mona.receive(log, p));
});

test("open(thread, log) fetches a thread outside the window from the log its address names", async (t) => {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open } = cast(t, w);
  const old = post(t, w, "olga", open, "Old");
  // more than two years on: the window serves no summary of it
  w.clock.advance(800 * DAY);
  post(t, w, "olga", open, "New");
  const mona = client(w, "mona");
  const log = `space:${open}` as const;
  await mona.sync(log, "window");
  t.is(mona.get(threadKey(old)), undefined);
  t.is(await mona.open(old), "missing", "without the log, nothing to fetch from");
  t.is(await mona.open(old, log), "full");
  t.is(mona.get(threadKey(old))?.kind, "thread");
  t.true(mona.keysIn("thread", { sp: open }).includes(threadKey(old)));
  t.is(await mona.open(w.id(), log), "missing", "a thread the server does not serve");
});

test("keysIn reads an index with the pending writes' predictions", async (t) => {
  const { w, open } = cast(t);
  const mona = client(w, "mona");
  await mona.sync("user:mona");
  await mona.sync(`space:${open}`, "window");
  const id = w.id();
  mona.queue("threads.create", { id, space: open, kind: "post", q: "Predicted" });
  t.true(mona.keysIn("thread", { sp: open }).includes(threadKey(id)));
});
