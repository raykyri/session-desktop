// `POST /api/sync/read` (`01` R5, `04` Z1): a reader of many channels reads
// their logs in one request, counted once against the snapshot limit, and
// each log is read under the caller's own scope.

import type { StoredRecord } from "@session/mutators";
import test from "ava";

import { createHarness } from "./helpers.js";
import { Person, newId } from "./syncHttp.js";

interface ReadAnswers {
  answers: (
    | { records: { key: string; record: StoredRecord }[]; cursor: string }
    | { changes: { key: string }[]; cursor: string }
    | { resync: true }
    | { error: { code: string } }
  )[];
}

const read = (h: ReturnType<typeof createHarness>, body: unknown, cookie?: string) =>
  h.request("/api/sync/read", {
    method: "POST",
    ...(cookie ? { cookie } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("forty open channels and a private one in one request, signed out, each filtered by its scope", async (t) => {
  // 41 reads cost 1 + 4 snapshots: two such requests fit in 10
  const h = createHarness(t, {
    env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "10", SESSION_LIMIT_SPACES_PER_DAY: "41" },
  });
  const olga = new Person(h, h.addUser("olga"));
  const open: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = newId();
    await olga.ok("spaces.create", { id, name: `room-${i}` });
    open.push(id);
  }
  const lab = newId();
  await olga.ok("spaces.create", { id: lab, name: "lab", vis: "private" });
  const secret = newId();
  await olga.ok("threads.create", { id: secret, space: lab, kind: "post", q: "Members only" });
  const shown = newId();
  await olga.ok("threads.create", { id: shown, space: open[0], kind: "post", q: "For anyone" });

  const reads = [...open, lab].map((sp) => ({ log: `space:${sp}`, tier: "summary" }));
  const res = await read(h, { reads });
  t.is(res.status, 200);
  const { answers } = (await res.json()) as ReadAnswers;
  t.is(answers.length, 41);
  const keys = (i: number) => {
    const a = answers[i];
    return a && "records" in a ? a.records.map((r) => r.key) : [];
  };
  t.true(keys(0).includes(`thread:${shown}`));
  // the private channel's landing only
  t.deepEqual(keys(40), [`space:${lab}`]);

  // a pull with the cursor each snapshot gave, in the same kind of request
  const cursor = (answers[0] as { cursor: string }).cursor;
  const again = await read(h, { reads: [{ log: `space:${open[0]}`, cursor }] });
  t.is(again.status, 200);
  const pulled = ((await again.json()) as ReadAnswers).answers[0];
  t.true(pulled !== undefined && "changes" in pulled);

  // the third costs 5 more, past the 10 a minute: refused in the protocol
  // shape, with Retry-After
  const refused = await read(h, { reads });
  t.is(refused.status, 429);
  t.like(await refused.json(), { code: "TOO_MANY_REQUESTS" });
  t.true(Number(refused.headers.get("retry-after")) >= 1);
});

test("a read the server half refuses answers its error in its place", async (t) => {
  const h = createHarness(t);
  const res = await read(h, { reads: [{ log: "user:nobody" }, { log: 3 }] });
  t.is(res.status, 200);
  const { answers } = (await res.json()) as ReadAnswers;
  t.like(answers[1], { error: { code: "BAD_REQUEST" } });
  t.is((await read(h, { reads: [] })).status, 400);
  t.is(
    (await read(h, { reads: Array.from({ length: 101 }, () => ({ log: "user:a" })) })).status,
    400,
  );
});

// ---- after the M4 review: scope per tier and caller, limits, the budget ----

type Answer = ReadAnswers["answers"][number];

const keysIn = (a: Answer | undefined): string[] =>
  !a
    ? []
    : "records" in a
      ? a.records.map((r) => r.key)
      : "changes" in a
        ? a.changes.map((c) => c.key)
        : [];

async function answersOf(res: Response): Promise<Answer[]> {
  if (res.status !== 200) throw new Error(`read answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as ReadAnswers).answers;
}

/** olga's private #lab with a thread and a reply; mel a member, mona not;
 * wanda waiting. Cursors served before the thread, for the pulls. */
async function privateLab(h: ReturnType<typeof createHarness>) {
  const olga = new Person(h, h.addUser("olga"));
  const mel = new Person(h, h.addUser("mel"));
  const mona = new Person(h, h.addUser("mona"));
  const lab = newId();
  await olga.ok("spaces.create", { id: lab, name: "lab", vis: "private" });
  const link = (await olga.ok("invites.create", { id: newId(), space: lab, days: 7 })) as {
    code: string;
  };
  await mel.ok("spaces.join", { space: lab, invite: link.code });
  await mona.register();
  const log = `space:${lab}`;
  const before = new Map<string, string>();
  for (const [who, cookie] of [
    ["anon", undefined],
    ["mona", mona.cookie],
    ["mel", mel.cookie],
  ] as const) {
    const [snap] = await answersOf(await read(h, { reads: [{ log }] }, cookie));
    before.set(who, (snap as { cursor: string }).cursor);
  }
  const secret = newId();
  await olga.ok("threads.create", { id: secret, space: lab, kind: "post", q: "Members only" });
  const reply = newId();
  await mel.ok("research.createPostFollowUp", { id: reply, thread: secret, t: "A reply" });
  return { olga, mel, mona, lab, log, secret, reply, before };
}

test("a private channel's thread reaches a member, and neither a signed-out reader nor a non-member, in every tier and in a pull", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "1000" } });
  const { mel, mona, log, secret, before } = await privateLab(h);
  const wanda = h.signIn(h.addWaitingUser("wanda"));
  const callers = [
    ["anon", undefined, false],
    ["waiting", wanda, false],
    ["mona", mona.cookie, false],
    ["mel", mel.cookie, true],
  ] as const;
  for (const [who, cookie, member] of callers) {
    const cursor = before.get(who === "waiting" ? "anon" : who) ?? "";
    const shapes = [
      { log, tier: "threads", threads: [secret] },
      { log, tier: "window" },
      { log, tier: "summary" },
      { log },
      { log, cursor },
    ];
    for (const shape of shapes) {
      const [a] = await answersOf(await read(h, { reads: [shape] }, cookie));
      t.is(
        keysIn(a).includes(`thread:${secret}`),
        member,
        `${who} ${JSON.stringify({ ...shape, cursor: undefined })}`,
      );
    }
  }
});

test("a summary holds no replies of a thread that has them, and a window does", async (t) => {
  const h = createHarness(t);
  const olga = new Person(h, h.addUser("olga"));
  const open = newId();
  await olga.ok("spaces.create", { id: open, name: "lounge" });
  const th = newId();
  await olga.ok("threads.create", { id: th, space: open, kind: "post", q: "A post" });
  const reply = newId();
  await olga.ok("research.createPostFollowUp", { id: reply, thread: th, t: "A reply" });
  const log = `space:${open}`;
  const [summary] = await answersOf(await read(h, { reads: [{ log, tier: "summary" }] }));
  t.true(keysIn(summary).includes(`thread:${th}`));
  t.false(keysIn(summary).some((k) => k.startsWith("reply:")));
  const [win] = await answersOf(await read(h, { reads: [{ log, tier: "window" }] }));
  t.true(keysIn(win).includes(`reply:${reply}`));
});

test("a pull in a read request carries the caller's client id: its lastSeq follows a write", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("seq"));
  await p.register();
  const [snap] = await answersOf(
    await read(h, { reads: [{ log: "user:seq" }], clientId: p.clientId }, p.cookie),
  );
  await p.ok("prefs.set", { layout: "wide" });
  await p.ok("prefs.set", { layout: "centred" });
  const [pulled] = await answersOf(
    await read(
      h,
      {
        reads: [{ log: "user:seq", cursor: (snap as { cursor: string }).cursor }],
        clientId: p.clientId,
      },
      p.cookie,
    ),
  );
  t.like(pulled, { lastSeq: 2 });
  // another person's client id reports nothing
  const other = new Person(h, h.addUser("other"));
  const [theirs] = await answersOf(
    await read(h, { reads: [{ log: "user:other" }], clientId: p.clientId }, other.cookie),
  );
  t.like(theirs, { lastSeq: null });
});

test("a cursor of another reader or another log resyncs in a read request", async (t) => {
  const h = createHarness(t);
  const { mel, mona, log, lab, before } = await privateLab(h);
  const melCursor = before.get("mel") ?? "";
  const [theirs] = await answersOf(
    await read(h, { reads: [{ log, cursor: melCursor }] }, mona.cookie),
  );
  t.deepEqual(theirs, { resync: true });
  const [anon] = await answersOf(await read(h, { reads: [{ log, cursor: melCursor }] }));
  t.deepEqual(anon, { resync: true });
  const [otherLog] = await answersOf(
    await read(h, { reads: [{ log: "user:mel", cursor: melCursor }] }, mel.cookie),
  );
  t.deepEqual(otherLog, { resync: true });
  t.truthy(lab);
});

test("a read request names each log once; a threads-only request names at most 20 logs and 100 thread ids", async (t) => {
  const h = createHarness(t);
  const log = "space:01M7YC40KD0CWWSYC3M6FT4G01";
  const dup = await read(h, { reads: [{ log }, { log, tier: "summary" }] });
  t.is(dup.status, 400);
  t.like(await dup.json(), { code: "BAD_REQUEST" });
  const id = () => newId();
  const logs = (n: number) =>
    Array.from({ length: n }, (_, k) => ({
      log: `space:01M7YC40KD0CWWSYC3M6FT4G${String(k).padStart(2, "0")}`,
      tier: "threads",
      threads: [id()],
    }));
  t.is((await read(h, { reads: logs(20) })).status, 200);
  t.is((await read(h, { reads: logs(21) })).status, 400);
  const many = [{ log, tier: "threads", threads: Array.from({ length: 101 }, id) }];
  t.is((await read(h, { reads: many })).status, 400);
  many[0]?.threads.pop();
  t.is((await read(h, { reads: many })).status, 200);
});

test("a threads-only read takes one token from the thread-reads bucket; any other read 1 + 1 per 10 reads from the snapshots bucket", async (t) => {
  const at = Date.now();
  const h = createHarness(t, {
    limiterNow: () => at,
    env: {
      SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "3",
      SESSION_LIMIT_THREAD_READS_PER_MINUTE: "2",
      SESSION_LIMIT_THREAD_READS_PER_IP_PER_MINUTE: "3",
    },
  });
  const p = new Person(h, h.addUser("reader"));
  const log = (k: number) => `space:01M7YC40KD0CWWSYC3M6FT4G${String(k).padStart(2, "0")}`;
  const threads = { reads: [{ log: log(1), tier: "threads", threads: [newId()] }] };
  t.is((await read(h, threads, p.cookie)).status, 200);
  t.is((await read(h, threads, p.cookie)).status, 200);
  const refused = await read(h, threads, p.cookie);
  t.is(refused.status, 429);
  t.like(await refused.json(), { code: "TOO_MANY_REQUESTS" });
  t.true(Number(refused.headers.get("retry-after")) >= 1);
  // signed out, by IP: three
  for (let k = 0; k < 3; k += 1) t.is((await read(h, threads)).status, 200);
  t.is((await read(h, threads)).status, 429);
  // the snapshots bucket is untouched: 20 reads cost 3, the next 1 is refused
  const twenty = {
    reads: Array.from({ length: 20 }, (_, k) => ({ log: log(k), tier: "summary" })),
  };
  t.is((await read(h, twenty, p.cookie)).status, 200);
  t.is((await read(h, { reads: [{ log: log(1) }] }, p.cookie)).status, 429);
});

test("a read request past its work budget answers TOO_MANY_REQUESTS in place of the reads after it", async (t) => {
  const h = createHarness(t, {
    readBudget: { bytes: 600, ms: 10_000 },
    env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "1000" },
  });
  const olga = new Person(h, h.addUser("olga"));
  const reads = [];
  for (let k = 0; k < 4; k += 1) {
    const id = newId();
    await olga.ok("spaces.create", { id, name: `room-${k}`, desc: "x".repeat(250) });
    reads.push({ log: `space:${id}` });
  }
  const answers = await answersOf(await read(h, { reads }));
  t.true("records" in (answers[0] as object));
  t.like(answers[3], { error: { code: "TOO_MANY_REQUESTS" } });
  const served = answers.filter((a) => "records" in a).length;
  t.true(served >= 1 && served < 4, `${served} served`);
});

test("a read request yields to the event loop between its reads", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "1000" } });
  const reads = Array.from({ length: 60 }, (_, k) => ({
    log: `space:01M7YC40KD0CWWSYC3M6FT4G${String(k).padStart(2, "0")}`,
  }));
  let ticks = 0;
  let running = true;
  const spin = () => {
    ticks += 1;
    if (running) setImmediate(spin);
  };
  const body = JSON.stringify({ reads });
  const pending = h.request("/api/sync/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  setImmediate(spin);
  const res = await pending;
  running = false;
  t.is(res.status, 200);
  t.true(ticks >= 50, `${ticks} turns of the event loop during 60 reads`);
});

test("a threads read reads the thread index, not the whole log", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_WRITES_PER_MINUTE: "100000" } });
  const olga = new Person(h, h.addUser("olga"));
  const open = newId();
  await olga.ok("spaces.create", { id: open, name: "lounge" });
  const ids: string[] = [];
  for (let k = 0; k < 5; k += 1) {
    const id = newId();
    ids.push(id);
    await olga.ok("threads.create", { id, space: open, kind: "post", q: `post ${k}` });
  }
  const reply = newId();
  await olga.ok("research.createPostFollowUp", { id: reply, thread: ids[2], t: "A reply" });
  const log = `space:${open}`;
  let scans = 0;
  const logRows = h.sync.store.logRows.bind(h.sync.store);
  h.sync.store.logRows = (l, after) => {
    if (l === log && after === 0) scans += 1;
    return logRows(l, after);
  };
  const [a] = await answersOf(
    await read(h, { reads: [{ log, tier: "threads", threads: [ids[2] ?? ""] }] }),
  );
  t.is(scans, 0);
  t.deepEqual(keysIn(a).sort(), [`counts:${ids[2]}`, `reply:${reply}`, `thread:${ids[2]}`].sort());
  t.like(a, { full: [ids[2]] });
});

test("a read that fails answers INTERNAL_SERVER_ERROR in its place, is logged, and the others are served", async (t) => {
  const h = createHarness(t);
  const bad = "space:01M7YC40KD0CWWSYC3M6FT4G99";
  const snapshot = h.sync.server.snapshot.bind(h.sync.server);
  h.sync.server.snapshot = (actor, log, o) => {
    if (log === bad) throw new Error("a store fault");
    return snapshot(actor, log, o);
  };
  const res = await read(h, { reads: [{ log: "user:a" }, { log: bad }, { log: "user:b" }] });
  t.is(res.status, 200);
  const answers = await answersOf(res);
  t.like(answers[1], { error: { code: "INTERNAL_SERVER_ERROR" } });
  t.true("records" in (answers[0] as object) && "records" in (answers[2] as object));
  t.true(h.logs.some((l) => l.includes("sync read failed")));
});

test("the directory over the store: pages of open channels in creation order, none repeated or skipped, none private, for any caller", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_SPACES_PER_DAY: "100" } });
  const olga = new Person(h, h.addUser("olga"));
  // ids chosen in reverse: the walk follows the server's order, not the id's
  const at = Date.now();
  const made: string[] = [];
  for (let k = 0; k < 5; k += 1) {
    const id = newId(at - k * 1000);
    made.push(`room-${k}`);
    await olga.ok("spaces.create", { id, name: `room-${k}` });
    if (k === 2) await olga.ok("spaces.create", { id: newId(), name: "hidden", vis: "private" });
  }
  const mona = h.addUser("mona");
  const wanda = h.addWaitingUser("wanda");
  for (const user of [null, wanda, mona]) {
    const caller = h.caller(user);
    const seen: string[] = [];
    let cursor: string | undefined;
    let late = false;
    for (let k = 0; k < 10; k += 1) {
      const page = await caller.spaces.directory({ ...(cursor ? { cursor } : {}), limit: 2 });
      seen.push(...page.spaces.map((s) => s.name));
      t.true(page.spaces.every((s) => s.vis === "open"));
      // a channel created during the walk, with the lowest id yet, is not skipped
      if (!late && user === null) {
        late = true;
        await olga.ok("spaces.create", { id: newId(at - 100_000), name: "late" });
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const expected = [...made, "late"];
    t.deepEqual(seen, expected, `walk for ${user?.handle ?? "anon"}`);
  }
  t.deepEqual((await h.caller(null).spaces.directory({ cursor: "zzz" })).spaces, []);
});

test("byName over the store: any case, with or without a #, and a private channel's landing", async (t) => {
  const h = createHarness(t);
  const olga = new Person(h, h.addUser("olga"));
  await olga.ok("spaces.create", { id: newId(), name: "lab", vis: "private", desc: "About" });
  const anon = h.caller(null);
  for (const name of ["lab", "LAB", "#lab", " #Lab "])
    t.like((await anon.spaces.byName({ name })).space, { name: "lab", vis: "private" }, name);
  t.is((await anon.spaces.byName({ name: "nowhere" })).space, null);
});

test("SESSION_WEB_SUMMARY_DAYS bounds how far back a window snapshot serves summaries", async (t) => {
  const make = async (env: Record<string, string>) => {
    const h = createHarness(t, {
      env: { SESSION_WEB_WINDOW_CAP: "1", SESSION_WEB_WINDOW_THREADS: "1", ...env },
    });
    const olga = new Person(h, h.addUser("olga"));
    const open = newId();
    await olga.ok("spaces.create", { id: open, name: "lounge" });
    const old = newId();
    await olga.ok("threads.create", { id: old, space: open, kind: "post", q: "older" });
    await new Promise((r) => setTimeout(r, 20));
    await olga.ok("threads.create", { id: newId(), space: open, kind: "post", q: "newer" });
    const mona = new Person(h, h.addUser("mona"));
    const [a] = await answersOf(
      await read(h, { reads: [{ log: `space:${open}`, tier: "window" }] }, mona.cookie),
    );
    return keysIn(a).includes(`thread:${old}`);
  };
  t.true(await make({}), "a summary by default");
  t.false(await make({ SESSION_WEB_SUMMARY_DAYS: "0" }), "no row at all");
});

test("spaces.threadSpace answers a thread's channel to a reader who may read it, and the same null otherwise", async (t) => {
  const at = Date.now();
  const h = createHarness(t, {
    limiterNow: () => at,
    env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "100" },
  });
  const { olga, mel, mona, lab, secret } = await privateLab(h);
  const open = newId();
  await olga.ok("spaces.create", { id: open, name: "lounge" });
  const pub = newId();
  await olga.ok("threads.create", { id: pub, space: open, kind: "post", q: "For anyone" });
  const wanda = h.addWaitingUser("wanda");
  const ask = (user: Parameters<typeof h.caller>[0], thread: string) =>
    h.caller(user).spaces.threadSpace({ thread });
  t.deepEqual(await ask(mel.user, secret), { space: lab });
  t.deepEqual(await ask(olga.user, secret), { space: lab });
  for (const user of [null, wanda, mona.user])
    t.deepEqual(await ask(user, secret), { space: null }, user?.login ?? "signed out");
  for (const user of [null, wanda, mona.user, mel.user])
    t.deepEqual(await ask(user, pub), { space: open });
  t.deepEqual(await ask(mel.user, newId()), { space: null }, "no such thread");
  await t.throwsAsync(ask(null, "not-a-ulid"), { code: "BAD_REQUEST" } as never);
  // the snapshots bucket: a read request and the lookup share it
  const tight = createHarness(t, {
    limiterNow: () => at,
    env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "2" },
  });
  const user = tight.addUser("reader");
  t.is((await read(tight, { reads: [{ log: "user:reader" }] }, tight.signIn(user))).status, 200);
  await tight.caller(user).spaces.threadSpace({ thread: newId() });
  await t.throwsAsync(tight.caller(user).spaces.threadSpace({ thread: newId() }), {
    code: "TOO_MANY_REQUESTS",
  } as never);
});
