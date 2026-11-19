// Invariant 3: every pull and snapshot is filtered by the reader's scope at
// the time of the read, and a user log holds only that user's records.

import test, { type ExecutionContext } from "ava";

import type { LogId, Pull, StoredRecord } from "../src/index.js";

import { DAY, actor, admit, cast, ok, refused, thread, type Cast } from "./harness.js";
import { diff, expected } from "./oracle.js";

const kinds = (m: ReadonlyMap<string, StoredRecord>) =>
  [...new Set([...m.values()].map((r) => r.kind))].sort();
const snap = async (c: Cast, u: string | null, log: LogId) =>
  new Map((await c.w.server.snapshot(actor(u), log)).records.map((x) => [x.key, x.record]));
const changes = (p: Pull) => ("resync" in p ? null : p.changes);
/** The person a record belongs to: its author, maker or subject. */
const ownerOf = (r: StoredRecord) =>
  r.kind === "report" || r.kind === "invite"
    ? r.by
    : r.kind === "notif"
      ? r.to
      : "u" in r
        ? r.u
        : null;

/** Fill the cast's spaces with one of everything. */
async function busy(t: ExecutionContext, c: Cast) {
  const { w, open, closed } = c;
  const ask = await thread(t, w, "mel", closed, "ask");
  await ok(t, w.as("mona", "followups.ask", { id: w.id(), thread: ask, q: "and?" }));
  const post = await thread(t, w, "mona", closed, "post");
  await ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: post, t: "a reply" }),
  );
  await ok(t, w.as("mel", "reports.create", { id: w.id(), item: `p:${post}`, why: "off topic" }));
  await ok(t, w.as("mona", "reports.create", { id: w.id(), item: `a:${ask}`, why: "spam" }));
  await ok(t, w.as("mona", "invites.create", { id: w.id(), space: closed }));
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(t, w.as("mel", "likes.set", { thread: post, on: true }));
  await ok(t, w.as("mel", "saved.set", { kind: "thread", id: ask, on: true }));
  await ok(t, w.as("mona", "members.ban", { space: open, user: "eve" }));
  const openPost = await thread(t, w, "otto", open, "post");
  await ok(
    t,
    w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: openPost, t: "first" }),
  );
  return { ask, post, openPost };
}

test("every snapshot equals the read rules' projection, for every reader and log", async (t) => {
  const c = await cast(t);
  await busy(t, c);
  const people = [null, "olga", "ada", "mona", "mel", "otto", "eve"];
  const logs: LogId[] = [
    `space:${c.open}`,
    `space:${c.closed}`,
    `space:${c.vault}`,
    ...people.flatMap((u) => (u ? [`user:${u}` as LogId] : [])),
  ];
  for (const u of people)
    for (const log of logs) {
      const d = diff(await snap(c, u, log), expected(c.w.server.dump(), u, log));
      if (d) t.fail(`${u} ${log}\n${d}`);
    }
  t.pass();
});

test("a non-member of a closed space gets its landing, the staff list and their own request, not their threads", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  await busy(t, c);
  await admit(t, w, closed, "rita");
  const mine = await thread(t, w, "rita", closed, "ask");
  await ok(t, w.as("rita", "followups.ask", { id: w.id(), thread: mine, q: "more" }));
  await ok(t, w.as("rita", "spaces.leave", { space: closed }));
  const got = await snap(c, "rita", `space:${closed}`);
  t.deepEqual(kinds(got), ["request", "space"]);
  for (const r of got.values()) if (r.kind !== "space") t.is((r as { u: string }).u, "rita");
  const space = got.get(`space:${closed}`);
  t.deepEqual(space?.kind === "space" ? space.mods.map(([u]) => u) : [], ["olga", "ada", "mona"]);
  // otto, who only asked to join, gets the landing and his own request (through his user log)
  t.deepEqual(kinds(await snap(c, "otto", `space:${closed}`)), ["request", "space"]);
  t.deepEqual(kinds(await snap(c, "otto", "user:otto")), ["member", "request"]);
});

test("a signed-out caller gets open spaces and the landings of closed ones", async (t) => {
  const c = await cast(t);
  await busy(t, c);
  t.deepEqual(kinds(await snap(c, null, `space:${c.closed}`)), ["space"]);
  t.deepEqual(kinds(await snap(c, null, `space:${c.vault}`)), ["space"]);
  t.deepEqual(kinds(await snap(c, null, `space:${c.open}`)), [
    "member",
    "reply",
    "space",
    "stats",
    "thread",
  ]);
  t.deepEqual(kinds(await snap(c, null, "user:mel")), []);
});

test("a removed member's cursor resyncs, and the new snapshot has none of the space's content", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  const { post } = await busy(t, c);
  const mel = w.client("mel");
  await mel.sync(`space:${closed}`);
  t.true(mel.records(`space:${closed}`).has(`thread:${post}`));
  const cursor = mel.cursor(`space:${closed}`);
  await ok(t, w.as("mona", "members.remove", { space: closed, user: "mel" }));
  const later = await thread(t, w, "olga", closed, "post", "after mel left");
  t.deepEqual(await w.server.pull(actor("mel"), `space:${closed}`, cursor!), { resync: true });
  t.is(await mel.sync(`space:${closed}`), "resync");
  const got = mel.records(`space:${closed}`);
  t.false(got.has(`thread:${post}`));
  t.false(got.has(`thread:${later}`));
  for (const r of got.values()) t.true(r.kind === "space" || ownerOf(r) === "mel", r.kind);
  t.is(diff(got, expected(w.server.dump(), "mel", `space:${closed}`)), null);
});

test("a cursor kept after leaving resyncs, and never carries content written after", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  await busy(t, c);
  const mel = w.client("mel");
  await mel.sync(`space:${closed}`);
  const kept = mel.cursor(`space:${closed}`)!;
  await ok(t, w.as("mel", "spaces.leave", { space: closed }));
  const later = await thread(t, w, "olga", closed, "post", "secret");
  t.deepEqual(await w.server.pull(actor("mel"), `space:${closed}`, kept), { resync: true });
  // the cursor of the snapshot taken after leaving never brings later content either
  const fresh = await w.server.snapshot(actor("mel"), `space:${closed}`);
  await thread(t, w, "ada", closed, "post", "more secret");
  const p = await w.server.pull(actor("mel"), `space:${closed}`, {
    epoch: fresh.epoch,
    version: fresh.version,
  });
  t.deepEqual(
    changes(p)?.map((x) => x.key),
    [],
  );
  t.false(fresh.records.some((x) => x.key === `thread:${later}`));
});

test("another person's user log gives nothing, with any cursor", async (t) => {
  const c = await cast(t);
  const { w } = c;
  await busy(t, c);
  const mel = w.client("mel");
  await mel.sync("user:mel");
  t.true(mel.records("user:mel").size > 0);
  const cursor = { epoch: "e0", version: 0 };
  for (const u of ["eve", "mona", "olga", null]) {
    t.deepEqual((await w.server.snapshot(actor(u), "user:mel")).records, []);
    t.deepEqual(changes(await w.server.pull(actor(u), "user:mel", cursor)), []);
    t.deepEqual(changes(await w.server.pull(actor(u), "user:mel", mel.cursor("user:mel")!)), []);
  }
});

test("a user log holds only that user's records", async (t) => {
  const c = await cast(t);
  await busy(t, c);
  for (const u of ["olga", "ada", "mona", "mel", "otto"]) {
    const got = await snap(c, u, `user:${u}`);
    t.true(got.size > 0, u);
    for (const r of got.values()) {
      t.is(ownerOf(r), u, `${u}: ${r.kind}`);
    }
  }
});

test("a plain member gets no moderator-only records, in snapshots or pulls", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  const mel = w.client("mel");
  const mona = w.client("mona");
  await mel.sync(`space:${closed}`);
  await mona.sync(`space:${closed}`);
  const before = mel.cursor(`space:${closed}`)!;
  await busy(t, c);
  await mel.sync(`space:${closed}`);
  await mona.sync(`space:${closed}`);
  const own = (r: StoredRecord) => ownerOf(r) === "mel";
  for (const r of mel.records(`space:${closed}`).values())
    t.false(
      ["request", "ban", "invite", "report"].includes(r.kind) && !own(r),
      `mel holds ${r.kind}`,
    );
  t.deepEqual(
    kinds(mona.records(`space:${closed}`)).filter((k) =>
      ["request", "report", "invite"].includes(k),
    ),
    ["invite", "report", "request"],
  );
  // the rows mel may not read are left out of the pull: not even a key
  const p = changes(await w.server.pull(actor("mel"), `space:${closed}`, before)) ?? [];
  const keys = p.map((x) => x.key);
  t.false(keys.some((k) => k.startsWith("request:") || k.startsWith("invite:")));
  t.is(keys.filter((k) => k.startsWith("report:")).length, 1);
});

test("the version a pull returns is the server's, not the space's", async (t) => {
  const c = await cast(t);
  const { w, open, closed } = c;
  const s = await w.server.snapshot(actor("eve"), `space:${closed}`);
  await thread(t, w, "mel", closed, "post", "activity eve should not see");
  const other = await thread(t, w, "mel", closed);
  await ok(t, w.as("mel", "likes.set", { thread: other, on: true }));
  const p1 = await w.server.pull(actor("eve"), `space:${closed}`, {
    epoch: s.epoch,
    version: s.version,
  });
  const s2 = await w.server.snapshot(actor("eve"), `space:${open}`);
  const p2 = await w.server.pull(actor("eve"), `space:${open}`, {
    epoch: s2.epoch,
    version: s2.version,
  });
  if ("resync" in p1 || "resync" in p2) return t.fail("unexpected resync");
  t.is(p1.version, p2.version);
  // the space's activity is in its stats record, which eve may not read
  t.deepEqual(p1.changes, []);
});

test("a non-member sees no change to any record after a post in a closed space", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  await busy(t, c);
  const readers = [null, "eve", "otto"];
  const logs: LogId[] = [`space:${closed}`, `space:${c.open}`, `space:${c.vault}`];
  const before = new Map<string, string>();
  const cursors = new Map<string, { epoch: string; version: number }>();
  for (const u of readers)
    for (const log of logs) {
      const s = await c.w.server.snapshot(actor(u), log);
      before.set(`${u} ${log}`, JSON.stringify(s.records));
      cursors.set(`${u} ${log}`, { epoch: s.epoch, version: s.version });
    }
  const th = await thread(t, w, "mel", closed, "post", "activity");
  await ok(
    t,
    w.as("mona", "followups.ask", {
      id: w.id(),
      thread: await thread(t, w, "ada", closed),
      q: "x",
    }),
  );
  await ok(t, w.as("ada", "likes.set", { thread: th, on: true }));
  await ok(t, w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: th, t: "x" }));
  for (const u of readers)
    for (const log of logs) {
      const s = await c.w.server.snapshot(actor(u), log);
      t.is(JSON.stringify(s.records), before.get(`${u} ${log}`) ?? "", `${u} ${log}`);
      const p = await c.w.server.pull(actor(u), log, cursors.get(`${u} ${log}`)!);
      t.deepEqual("resync" in p ? null : p.changes, [], `${u} ${log}`);
    }
});

test("a forged cursor resyncs", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  const s = await w.server.snapshot(actor("eve"), `space:${closed}`);
  for (const cursor of [
    { epoch: s.epoch, version: s.version + 1 },
    { epoch: "e999", version: s.version },
    { epoch: s.epoch, version: -1 },
    { epoch: s.epoch, version: 1.5 },
    { epoch: s.epoch, version: Number.NaN },
    { epoch: s.epoch, version: 0, extra: 1 },
  ])
    t.deepEqual(await w.server.pull(actor("eve"), `space:${closed}`, cursor), { resync: true });
  for (const log of ["space:", "user:", "space:a:b", "other:x", "user:mel:x"] as LogId[]) {
    t.deepEqual(await w.server.pull(actor("eve"), log, s), { resync: true }, log);
    t.deepEqual((await w.server.snapshot(actor("eve"), log)).records, [], log);
  }
});

test("a cursor from before its epoch began resyncs, so it gets no tombstones of the old history", async (t) => {
  // attack B of the phase 0 review: a forged cursor { epoch: current,
  // version: 0 } after a closed space opened returned the `del` of a member
  // who left while it was closed
  const c = await cast(t);
  const { w, closed } = c;
  await busy(t, c);
  await ok(t, w.as("mel", "spaces.leave", { space: closed }));
  await ok(t, w.as("olga", "spaces.update", { id: closed, set: { vis: "open" } }));
  const s = await w.server.snapshot(actor("eve"), `space:${closed}`);
  t.false(s.records.some((x) => x.key === `member:${closed}:mel`));
  for (const u of ["eve", null, "otto"])
    for (let version = 0; version < s.version; version++)
      t.deepEqual(
        await w.server.pull(actor(u), `space:${closed}`, { epoch: s.epoch, version }),
        { resync: true },
        `${u} ${version}`,
      );
  // a cursor from the epoch's start on is served
  const p = await w.server.pull(actor("eve"), `space:${closed}`, {
    epoch: s.epoch,
    version: s.version,
  });
  t.deepEqual(changes(p), []);
});

test("a space that becomes closed resyncs every reader, and non-members lose its content", async (t) => {
  const c = await cast(t);
  const { w, open } = c;
  const { openPost } = await busy(t, c);
  const eve = w.client("eve");
  const anon = w.client(null);
  await eve.sync(`space:${open}`);
  await anon.sync(`space:${open}`);
  t.true(eve.records(`space:${open}`).has(`thread:${openPost}`));
  await ok(t, w.as("olga", "spaces.update", { id: open, set: { vis: "listed" } }));
  t.is(await eve.sync(`space:${open}`), "resync");
  t.is(await anon.sync(`space:${open}`), "resync");
  t.deepEqual(kinds(eve.records(`space:${open}`)), ["space"]);
  t.deepEqual(kinds(anon.records(`space:${open}`)), ["space"]);
});

test("a summary-tier snapshot is scoped as a full one, and holds no more", async (t) => {
  const c = await cast(t);
  await busy(t, c);
  for (const u of [null, "mona", "mel", "otto", "eve"])
    for (const log of [`space:${c.open}`, `space:${c.closed}`] as LogId[]) {
      const want = expected(c.w.server.dump(), u, log);
      const summary = await c.w.server.snapshot(actor(u), log, { tier: "summary" });
      for (const { key, record } of summary.records)
        t.deepEqual(record, want.get(key), `${u} ${key}`);
      t.false(summary.records.some((x) => ["followup", "reply", "run"].includes(x.record.kind)));
    }
});

test("a removed member's device keeps a frozen copy of their threads, and can still delete them", async (t) => {
  // attack H of the phase 0 review, under the owner's decision: the server
  // serves nothing of a closed space to a non-member, their own threads
  // included; the author may still delete them
  const c = await cast(t);
  const { w, closed } = c;
  const th = await thread(t, w, "mel", closed, "post", "mine");
  const melsReply = w.id();
  await ok(t, w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: th, t: "ada's" }));
  await ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: melsReply, thread: th, t: "mel's" }),
  );
  const other = await thread(t, w, "ada", closed, "post", "ada's thread");
  const mel = w.client("mel");
  await mel.sync(`space:${closed}`);
  await ok(t, w.as("olga", "members.remove", { space: closed, user: "mel" }));
  t.is(await mel.sync(`space:${closed}`), "resync");
  const live = mel.records(`space:${closed}`);
  t.false(live.has(`thread:${th}`));
  t.deepEqual(kinds(live), ["request", "space"]);
  // the frozen copy: mel's thread and mel's reply under it; not ada's reply,
  // not other threads
  const frozen = mel.frozen(`space:${closed}`);
  t.is((frozen.get(`thread:${th}`) as { q: string } | undefined)?.q, "mine");
  t.deepEqual([...frozen.keys()].sort(), [`reply:${melsReply}`, `thread:${th}`].sort());
  t.false(frozen.has(`thread:${other}`));
  // no further updates reach it, and the server serves none of it
  await ok(t, w.as("mona", "likes.set", { thread: th, on: true }));
  await mel.sync(`space:${closed}`);
  t.is((mel.frozen(`space:${closed}`).get(`thread:${th}`) as { likes: number }).likes, 0);
  const s = await w.server.snapshot(actor("mel"), `space:${closed}`);
  t.false(JSON.stringify(s).includes(th));
  // the author may delete it all the same; nobody else may, and mel may not edit it
  await refused(
    t,
    w.as("mel", "threads.update", { id: th, q: "x", base: { rev: 1 } }),
    "NOT_FOUND",
  );
  await refused(t, w.as("mel", "threads.delete", { id: other }), "NOT_FOUND");
  mel.queue("threads.delete", { id: th });
  const [r] = await mel.flush();
  t.true(r?.ok);
  t.true((w.get(`thread:${th}`) as { del: boolean }).del);
  t.is(mel.frozen(`space:${closed}`).size, 0);
});

test("lists come in the server's creation order, not the time a client put in an id", async (t) => {
  const c = await cast(t);
  const { w, open } = c;
  const late = w.id(-3 * DAY);
  w.clock.advance(1000);
  const early = w.id();
  await ok(t, w.as("mel", "threads.create", { id: early, space: open, kind: "post", q: "first" }));
  w.clock.advance(1000);
  await ok(t, w.as("mel", "threads.create", { id: late, space: open, kind: "post", q: "second" }));
  const order = (await w.server.snapshot(actor("eve"), `space:${open}`)).records
    .filter((x) => x.record.kind === "thread")
    .map((x) => x.key);
  t.deepEqual(order, [`thread:${early}`, `thread:${late}`]);
});
