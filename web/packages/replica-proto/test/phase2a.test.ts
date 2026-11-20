// Phase 2a: a device's `runs.turn` is a stored `turn` record (report-1b
// finding 6). Invariant 6 for turns: a turn is text of its run's node, so a
// reader who may not read the node's text gets the turn without it, and a
// removal or a delete leaves none of it at rest (the storage scan). It runs
// where the server under test has online calls (`TestServer.online`).

import test from "ava";

import type { LogId } from "../src/index.js";

import { cast, ok } from "./harness.js";
import { expected } from "./oracle.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment -- call results are read as `any` */
type Any = any;

test("a device's turns are records: blanked with a hidden node, erased with a removed one", async (t) => {
  const { w, open } = await cast(t);
  const on = w.server.online;
  if (!on) return t.pass("the server under test has no online calls");
  const a = (await on.call(null, "devices.authorize", { name: "mel's mac" })) as Any;
  await on.call({ u: "mel" }, "devices.approve", {
    request: a.result.request,
    code: a.result.code,
  });
  const c = (await on.call(null, "devices.token", { request: a.result.request })) as Any;
  const device = c.result.device as string;
  const as = { u: "mel", device };
  const executor = { kind: "device", cli: "claude", device };
  const th = w.id();
  const r = (await ok(
    t,
    w.as("mel", "threads.create", { id: th, space: open, kind: "ask", q: "Q", executor }),
  )) as { run: string };
  const fu = w.id();
  const f = (await ok(
    t,
    w.as("mel", "research.forkNode", { id: fu, thread: th, parent: "r", q: "F", executor }),
  )) as { run: string };
  for (const [run, mark] of [
    [r.run, "mk-turn-ask"],
    [f.run, "mk-turn-fu"],
  ] as const) {
    t.true((await on.call(as, "runs.claim", { run, device })).ok);
    t.true((await on.call(as, "runs.turn", { run, device, attempt: 1, turn: mark })).ok);
  }
  const log: LogId = `space:${open}`;
  const turns = async (u: string | null) => {
    const s = await w.server.snapshot(u === null ? null : { u }, log);
    return s.records
      .filter((x) => (x.record.kind as string) === "turn")
      .map((x) => (x.record as unknown as { body: unknown }).body)
      .sort();
  };
  t.deepEqual(await turns(null), ["mk-turn-ask", "mk-turn-fu"]);
  // the turns a snapshot serves are those the read oracle says a reader holds
  const matchOracle = async () => {
    for (const u of [null, "otto", "mel", "mona"]) {
      const s = await w.server.snapshot(u === null ? null : { u }, log);
      const isTurn = ([, r]: [string, { kind: string }]) => r.kind === "turn";
      t.deepEqual(
        new Map(
          s.records.map((x) => [x.key, x.record] as [string, typeof x.record]).filter(isTurn),
        ),
        new Map([...expected(w.server.dump(), u, log)].filter(isTurn)),
        String(u),
      );
    }
  };
  await matchOracle();
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `f:${th}:${fu}`,
      decision: "hidden",
      base: w.item(`f:${th}:${fu}`),
    }),
  );
  t.deepEqual(await turns(null), [null, "mk-turn-ask"].sort() as never);
  t.deepEqual(await turns("mel"), ["mk-turn-ask", "mk-turn-fu"]);
  await matchOracle();
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `f:${th}:${fu}`,
      decision: "removed",
    }),
  );
  t.false(JSON.stringify(await w.server.scanStorage()).includes("mk-turn-fu"));
  t.true(JSON.stringify(await w.server.scanStorage()).includes("mk-turn-ask"));
  await ok(t, w.as("mel", "threads.delete", { id: th }));
  t.false(JSON.stringify(await w.server.scanStorage()).includes("mk-turn"));
});
