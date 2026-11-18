// Invariant 3: every pull and snapshot is filtered by the reader's scope at
// the time of the read, and a user log holds only that user's records.

import test, { type ExecutionContext } from "ava";

import type { LogId, Pull, StoredRecord } from "../src/index.js";

import { actor, admit, cast, ok, thread, type Cast } from "./harness.js";
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
  await ok(t, w.as("mel", "saved.toggle", { kind: "thread", id: ask }));
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

test("a non-member of a closed space gets its landing, the staff list and their own threads", async (t) => {
  const c = await cast(t);
  const { w, closed } = c;
  await busy(t, c);
  await admit(t, w, closed, "rita");
  const mine = await thread(t, w, "rita", closed, "ask");
  await ok(t, w.as("rita", "followups.ask", { id: w.id(), thread: mine, q: "more" }));
  await ok(t, w.as("rita", "spaces.leave", { space: closed }));
  const got = await snap(c, "rita", `space:${closed}`);
  t.deepEqual(kinds(got), ["followup", "request", "run", "space", "thread"]);
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
    [`space:${closed}`],
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
  // the space record's post count changed (it is public); nothing else
  t.deepEqual(
    p1.changes.map((x) => x.key),
    [`space:${closed}`],
  );
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
  for (const log of ["space:", "user:", "space:a:b", "other:x", "user:mel:x"] as LogId[])
    t.deepEqual(changes(await w.server.pull(actor("eve"), log, s)) ?? [], []);
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
      const summary = await c.w.server.snapshot(actor(u), log, "summary");
      for (const { key, record } of summary.records)
        t.deepEqual(record, want.get(key), `${u} ${key}`);
      t.false(summary.records.some((x) => ["followup", "reply", "run"].includes(x.record.kind)));
    }
});
