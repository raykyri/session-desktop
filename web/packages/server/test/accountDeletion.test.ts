// The account-deletion operator job in the spaces (plan `04` B6, P2): the
// channels of a deleted owner are frozen and stay readable; a deleted
// member's items go through the author's delete path, the shells kept for
// other people's content lose the handle, and their user log and
// memberships go; after it no stored record and no served snapshot names
// the person but the moderation log; the handle stays taken and the
// identity is gone.

import { accounts, users } from "@session/db";
import { frozenMessage, type StoredRecord } from "@session/mutators";
import type { Snapshot } from "@session/sync/server";
import test from "ava";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";
import { MODEL, Person, channels, newId } from "./syncHttp.js";

/** The job, through the server's own sync core, as the outer transaction so
 * the commit wakes the streams. */
function deleteAccount(h: Harness, userId: string) {
  return h.sync.store.transaction(() =>
    accounts.deleteAccount(h.db, userId, { server: h.sync.server }),
  );
}

async function signedOutSnapshot(h: Harness, log: string): Promise<Snapshot> {
  const res = await h.request("/api/sync/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ log }),
  });
  return (await res.json()) as Snapshot;
}

const keys = (s: Snapshot) => s.records.map((r) => r.key);

/** What the run loop writes when `node`'s run ends: a turn and the answer
 * with `md`. */
function answer(h: Harness, th: string, node: string, md: string): string {
  const done = h.sync.server.serverApply({ me: "" }, (tx) => {
    const run = tx.list("run", { th }).find((r) => r.node === node);
    if (!run) throw new Error(`no run of ${node}`);
    tx.put({ ...run, status: "complete", step: 3, finishedAt: tx.now });
    tx.put({
      kind: "turn",
      run: run.id,
      attempt: run.attempt,
      n: 0,
      th,
      s: run.s,
      role: "assistant",
      blocks: [{ type: "text", text: md }],
      createdAt: tx.now,
    });
    tx.put({
      kind: "answer",
      node,
      th,
      s: run.s,
      u: run.u,
      md,
      pages: [],
      tok: 10,
      run: run.id,
      attempt: run.attempt,
      mod: null,
    });
    if (node === "r") {
      const p = tx.byKey(`thread:${th}`);
      if (p?.kind === "thread") tx.put({ ...p, running: false, sum: `Summary of ${md}` });
    }
    return run.id;
  });
  if (!done.ok) throw new Error(done.error.code);
  return done.result;
}

function stored(h: Harness): StoredRecord[] {
  return h.sync.store.sqlite
    .prepare<[], { body: string }>("SELECT body FROM records")
    .all()
    .map((r) => JSON.parse(r.body) as StoredRecord);
}

test("B6: the frozen channels of a deleted owner", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  const eve = new Person(h, h.addUser("eve"));
  const post = newId();
  await mona.ok("threads.create", { id: post, space: open, kind: "post", q: "Mona's post" });
  const secret = newId();
  await mel.ok("threads.create", { id: secret, space: closed, kind: "post", q: "Lab notes" });
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };

  const done = deleteAccount(h, olga.user.id);
  t.deepEqual(done.spaces?.frozen.sort(), ["lab", "lounge"]);

  const refusal = await mona.write("threads.create", {
    id: newId(),
    space: open,
    kind: "post",
    q: "After",
  });
  t.like(refusal, { ok: false, error: { code: "FORBIDDEN", message: frozenMessage("lounge") } });
  t.like(await eve.write("spaces.join", { space: open }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await eve.write("spaces.join", { space: closed, invite: link.code }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  // a person still deletes their own thread
  t.like(await mona.write("threads.delete", { id: post }), { ok: true });
  // olga's invite links went with her
  t.false(stored(h).some((r) => r.kind === "invite" && r.by === "olga"));

  // readable as before: the open channel by anyone, the private one by its members
  const lounge = await signedOutSnapshot(h, `space:${open}`);
  t.true(keys(lounge).includes(`space:${open}`));
  t.true(keys(lounge).includes(`thread:${post}`));
  const space = lounge.records.find((r) => r.key === `space:${open}`)?.record;
  t.like(space, { frozen: true, owner: "olga" });
  const lab = await mel.snapshot(`space:${closed}`);
  t.true(keys(lab).includes(`thread:${secret}`));
  t.false(keys(await signedOutSnapshot(h, `space:${closed}`)).includes(`thread:${secret}`));

  // the handle stays taken; the identity is gone
  const row = h.db.$client
    .prepare("SELECT provider, provider_user_id AS pid FROM users WHERE handle = ?")
    .get("olga") as { provider: string | null; pid: string | null };
  t.deepEqual(row, { provider: null, pid: null });
  t.false(users.handleAvailable(h.db, "olga"));
});

test("P2: a deleted member's items go by the author's delete path; their user log, memberships, bans and links go", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  // mel's post with mona's reply stays as an empty shell; mel's lone post goes
  const replied = newId();
  await mel.ok("threads.create", { id: replied, space: open, kind: "post", q: "Replied to" });
  await mona.ok("research.createPostFollowUp", { id: newId(), thread: replied, t: "A reply" });
  const lone = newId();
  await mel.ok("threads.create", { id: lone, space: closed, kind: "post", q: "Alone" });
  const reply = newId();
  const monas = newId();
  await mona.ok("threads.create", { id: monas, space: open, kind: "post", q: "Mona's" });
  await mel.ok("research.createPostFollowUp", { id: reply, thread: monas, t: "Mel's reply" });
  await mel.ok("saved.set", { kind: "thread", id: monas, on: true });
  await mona.ok("research.createPostFollowUp", {
    id: newId(),
    thread: monas,
    t: "Thanks @mel",
  });
  await olga.ok("members.ban", { space: open, user: "mona" });
  await olga.ok("members.unban", { space: open, user: "mona" });

  const done = deleteAccount(h, mel.user.id);
  t.like(done.spaces, { items: 3 });
  const left = stored(h);
  const mine = left.filter(
    (r) =>
      ("u" in r && r.u === "mel") ||
      (r.kind === "notif" && r.to === "mel") ||
      (r.kind === "invite" && r.by === "mel"),
  );
  // nothing names mel; his two threads are deleted, with no text and no
  // author: the one with mona's reply is a shell, the other is gone
  t.deepEqual(mine, []);
  const threads = left.filter((r) => r.kind === "thread" && (r.id === replied || r.id === lone));
  t.deepEqual(
    threads.map((r) => (r.kind === "thread" ? [r.id, r.q, r.del, r.gone, r.u] : r.kind)).sort(),
    [
      [replied, "", true, false, null],
      [lone, "", true, true, null],
    ].sort(),
  );
  t.false(left.some((r) => r.kind === "reply" && r.id === reply));
  t.false(left.some((r) => r.kind === "member" && r.u === "mel"));
  // the member counts follow: olga is left, mona's ban took her membership
  const lounge = left.find((r) => r.kind === "space" && r.id === open);
  t.like(lounge, { members: 1, frozen: false });
  // moderation log entries stay until retention
  t.true(left.some((r) => r.kind === "modlog" && r.author === "mona"));
  t.false(users.handleAvailable(h.db, "mel"));
});

test("P2: no stored record and no served snapshot names the deleted person but the moderation log", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  // mel branches in mona's ask, and mona comments on that branch
  const monasAsk = newId();
  await mona.ok("threads.create", {
    id: monasAsk,
    space: open,
    kind: "ask",
    q: "Mona asks",
    ...MODEL,
  });
  answer(h, monasAsk, "r", "Mona's answer");
  const branch = newId();
  await mel.ok("research.forkNode", {
    id: branch,
    thread: monasAsk,
    parent: "r",
    kind: "ask",
    q: "MEL-BRANCH-Q",
    ...MODEL,
  });
  const branchRun = answer(h, monasAsk, branch, "MEL-BRANCH-ANSWER");
  await mona.ok("comments.create", {
    id: newId(),
    thread: monasAsk,
    node: branch,
    t: "Mona's comment",
  });
  // mel's own ask, with mona's branch under it
  const melsAsk = newId();
  await mel.ok("threads.create", {
    id: melsAsk,
    space: open,
    kind: "ask",
    q: "MEL-ASK-Q",
    ...MODEL,
  });
  const rootRun = answer(h, melsAsk, "r", "MEL-ROOT-ANSWER");
  const monasBranch = newId();
  await mona.ok("research.forkNode", {
    id: monasBranch,
    thread: melsAsk,
    parent: "r",
    kind: "ask",
    q: "Mona's branch",
    ...MODEL,
  });
  // mel's reply to mona's post, with mona's reply under it; mel's lone post
  const post = newId();
  await mona.ok("threads.create", { id: post, space: open, kind: "post", q: "Mona's post" });
  const melsReply = newId();
  await mel.ok("research.createPostFollowUp", { id: melsReply, thread: post, t: "MEL-REPLY" });
  await mona.ok("research.createPostFollowUp", {
    id: newId(),
    thread: post,
    parent: melsReply,
    t: "Mona's reply",
  });
  const lone = newId();
  await mel.ok("threads.create", { id: lone, space: closed, kind: "post", q: "MEL-LONE" });
  // mel's comment on mona's ask, his save and layout; olga bans him after
  await mel.ok("comments.create", { id: newId(), thread: monasAsk, node: "r", t: "MEL-COMMENT" });
  await mel.ok("saved.set", { kind: "thread", id: post, on: true });
  await mel.ok("prefs.set", { layout: "wide" });
  await olga.ok("members.ban", { space: closed, user: "mel" });
  // mona was notified of mel's branch, reply and comment
  t.true(stored(h).some((r) => r.kind === "notif" && r.to === "mona" && r.actor === "mel"));

  deleteAccount(h, mel.user.id);

  const left = stored(h);
  const texts = [
    "MEL-BRANCH-Q",
    "MEL-BRANCH-ANSWER",
    "MEL-ASK-Q",
    "MEL-ROOT-ANSWER",
    "MEL-REPLY",
    "MEL-LONE",
    "MEL-COMMENT",
  ];
  for (const r of left) {
    const body = JSON.stringify(r);
    for (const text of texts) t.false(body.includes(text), `${r.kind} holds ${text}`);
    // the moderation log keeps the ban's entry until retention
    if (r.kind !== "modlog") t.false(body.includes('"mel"'), `${r.kind} names mel: ${body}`);
  }
  t.true(left.some((r) => r.kind === "modlog" && r.author === "mel"));
  // the shells stay for mona's content, without mel
  t.like(
    left.find((r) => r.kind === "node" && r.id === branch),
    { del: true, u: null, q: "" },
  );
  t.like(
    left.find((r) => r.kind === "thread" && r.id === melsAsk),
    {
      del: true,
      gone: false,
      u: null,
      q: "",
      sum: null,
    },
  );
  t.like(
    left.find((r) => r.kind === "reply" && r.id === melsReply),
    { del: true, u: null, t: "" },
  );
  t.like(
    left.find((r) => r.kind === "thread" && r.id === lone),
    { gone: true, u: null },
  );
  t.false(left.some((r) => r.kind === "run" && (r.id === branchRun || r.id === rootRun)));
  t.false(left.some((r) => r.kind === "turn" && (r.run === branchRun || r.run === rootRun)));
  t.false(left.some((r) => r.kind === "ban" && r.u === "mel"));
  t.true(left.some((r) => r.kind === "node" && r.id === monasBranch && r.u === "mona"));

  // served: signed out, and to olga and mona, every log they read
  const served = [
    await signedOutSnapshot(h, `space:${open}`),
    await signedOutSnapshot(h, `space:${closed}`),
    await olga.snapshot(`space:${open}`),
    await olga.snapshot(`space:${closed}`),
    await olga.snapshot("user:olga"),
    await mona.snapshot(`space:${open}`),
    await mona.snapshot("user:mona"),
  ];
  for (const snap of served)
    for (const { record } of snap.records) {
      if (!record || record.kind === "modlog") continue;
      const body = JSON.stringify(record);
      t.false(body.includes('"mel"'), body);
      for (const text of texts) t.false(body.includes(text), body);
    }
});

test("P2: the job deletes comments, branches and bans of the person, and a thread whose replies were all theirs goes", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open } = await channels(h);
  const ask = newId();
  await mona.ok("threads.create", { id: ask, space: open, kind: "ask", q: "Mona asks", ...MODEL });
  answer(h, ask, "r", "Mona's answer");
  const comment = newId();
  await mel.ok("comments.create", { id: comment, thread: ask, node: "r", t: "A comment" });
  const node = newId();
  await mel.ok("research.forkNode", {
    id: node,
    thread: ask,
    parent: "r",
    kind: "ask",
    q: "And?",
    ...MODEL,
  });
  const post = newId();
  await mel.ok("threads.create", { id: post, space: open, kind: "post", q: "Mel's post" });
  for (let k = 0; k < 2; k++)
    await mel.ok("research.createPostFollowUp", { id: newId(), thread: post, t: `Mel ${k}` });
  await olga.ok("members.ban", { space: open, user: "mel" });

  deleteAccount(h, mel.user.id);
  const left = stored(h);
  t.false(left.some((r) => r.kind === "comment" && r.u === "mel"));
  t.false(left.some((r) => r.kind === "comment" && r.id === comment));
  t.false(left.some((r) => r.kind === "node" && r.u === "mel"));
  t.false(left.some((r) => r.kind === "node" && r.id === node));
  t.false(left.some((r) => r.kind === "ban" && r.u === "mel"));
  t.like(
    left.find((r) => r.kind === "thread" && r.id === post),
    { del: true, gone: true },
  );
});

test("the job over its own connection refuses while the server runs", async (t) => {
  const h = createHarness(t);
  const { mel } = await channels(h);
  // boot starts the maintenance, which writes the heartbeat
  h.sync.startMaintenance();
  t.throws(() => accounts.deleteAccount(h.db, mel.user.id), {
    message: /needs the server stopped/,
  });
  t.not(users.findByHandle(h.db, "mel")?.provider ?? null, null);
});

interface Due {
  run: () => void;
  ms: number;
  next: number;
  unref(): void;
}

/** A clock and interval timers that move only when the test steps them:
 * `step(ms)` runs every interval that falls due on the way, at its time;
 * `moveTo(at)` sets the clock with no interval set yet. */
function steppedTime(start: number) {
  let at = start;
  const due = new Set<Due>();
  return {
    clock: { now: () => at },
    timers: {
      set(run: () => void, ms: number): Due {
        const handle = { run, ms, next: at + ms, unref: () => undefined };
        due.add(handle);
        return handle;
      },
      clear(handle: object) {
        due.delete(handle as Due);
      },
    },
    moveTo(to: number) {
      if (due.size) throw new Error("moveTo with intervals set");
      at = to;
    },
    step(ms: number) {
      const end = at + ms;
      for (;;) {
        const first = [...due].sort((a, b) => a.next - b.next)[0];
        if (!first || first.next > end) break;
        at = first.next;
        first.next += first.ms;
        first.run();
      }
      at = end;
    },
  };
}

const heartbeatAt = (h: Harness) =>
  (
    h.db.$client
      .prepare("SELECT updated_at AS at FROM server_meta WHERE key = 'server_heartbeat'")
      .get() as { at: number } | undefined
  )?.at;

test("S1, S2: a running server rewrites its heartbeat every 30 s, so the job refuses at boot + 91 s", async (t) => {
  const time = steppedTime(Date.now());
  const h = createHarness(t, { sync: { clock: time.clock, timers: time.timers } });
  const { mel } = await channels(h);
  // the server boots 91 s before the job, which reads this machine's clock
  time.moveTo(Date.now() - 91_000);
  h.sync.startMaintenance();
  const boot = time.clock.now();
  t.is(heartbeatAt(h), boot);
  time.step(30_000);
  t.is(heartbeatAt(h), time.clock.now(), "the beat 30 s after boot");
  time.step(61_000);
  t.is(heartbeatAt(h), boot + 90_000);
  t.throws(() => accounts.deleteAccount(h.db, mel.user.id), {
    message: /needs the server stopped: a server \(pid \d+\) wrote its heartbeat/,
  });
  t.not(users.findByHandle(h.db, "mel")?.provider ?? null, null);
});
