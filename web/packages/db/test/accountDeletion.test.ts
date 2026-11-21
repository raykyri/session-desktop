// The account-deletion job as the operator runs it (`db:admin -- --delete`,
// plan `04` B6, §8): with the server stopped, the spaces step writes through a
// sync core over the job's own connection.

import { MUTATORS, Refusal, type StoredRecord, type Tx } from "@session/mutators";
import { SyncServer } from "@session/sync/server";
import test from "ava";

import {
  HEARTBEAT_STALE_MS,
  RunTables,
  SqliteStore,
  accounts,
  clearHeartbeat,
  writeHeartbeat,
  type SessionDatabase,
} from "../src/index.js";

import { addActiveUser, createFixture } from "./helpers.js";

const MODEL = { model: "claude-fable", effort: "medium" } as const;
const LOUNGE = "01KAAAAAAAAAAAAAAAAAAAAAAA";

let n = 0;
/** A new id after the lounge's. */
const id = () => `01KB${String(++n).padStart(22, "0")}`;

/** The records the server would have written: each write's `can`, `run`
 * and `notify` over a server transaction. */
function world(db: SessionDatabase) {
  const server = new SyncServer({
    store: new SqliteStore(db),
    clock: { now: Date.now },
    mutators: MUTATORS,
  });
  const write = (me: string, name: string, input: unknown, values: Record<string, string> = {}) => {
    const def = MUTATORS[name];
    if (!def) throw new Error(name);
    const done = server.serverApply({ me }, (tx) => {
      const i = def.input.parse(input);
      def.can?.(tx, i);
      const r = def.run(tx, i, values);
      return def.notify?.(tx, i, r, { isAccount: () => true }) ?? r;
    });
    if (!done.ok) throw new Error(`${name}: ${done.error.code} ${done.error.message}`);
    return done.result;
  };
  /** What the run loop writes: a turn and the answer of `node`'s run. */
  const answer = (th: string, node: string, md: string) => {
    const done = server.serverApply({ me: "" }, (tx) => {
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
      return run.id;
    });
    if (!done.ok) throw new Error(done.error.code);
    return done.result;
  };
  const all = (): StoredRecord[] =>
    db.$client
      .prepare<[], { body: string }>("SELECT body FROM records")
      .all()
      .map((r) => JSON.parse(r.body) as StoredRecord);
  return { server, write, answer, all };
}

test("the job over its own connection freezes the owner's channels and erases their records", (t) => {
  const { db } = createFixture(t);
  const olga = addActiveUser(db, "olga");
  addActiveUser(db, "mona");
  const { write } = world(db);
  write("olga", "spaces.create", { id: LOUNGE, name: "lounge" });
  write("mona", "spaces.join", { space: LOUNGE });
  write("olga", "prefs.set", { layout: "wide" });

  const deleted = accounts.deleteAccount(db, olga.id);
  t.deepEqual(deleted.spaces, {
    items: 0,
    rewritten: 0,
    records: 2,
    frozen: ["lounge"],
    runs: [],
  });
  // a store opened afterwards, as the restarted server's is
  const after = new SqliteStore(db);
  t.like(after.byKey(`space:${LOUNGE}`), { frozen: true, owner: "olga", members: 1 });
  t.is(after.byKey(`member:${LOUNGE}:olga`), undefined);
  t.is(after.byKey("prefs:olga"), undefined);
  t.like(after.byKey(`member:${LOUNGE}:mona`), { role: "member" });
});

test("the job refuses while a server's heartbeat is fresh, and runs once it is deleted or stale", (t) => {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  writeHeartbeat(db, Date.now());
  t.throws(() => accounts.deleteAccount(db, mel.id), {
    message: /The account-deletion job needs the server stopped/,
  });
  t.is(
    (
      db.$client.prepare("SELECT deleted_at AS d FROM users WHERE id = ?").get(mel.id) as {
        d: number | null;
      }
    ).d,
    null,
  );
  // a server that was killed: its last heartbeat is stale
  writeHeartbeat(db, Date.now() - HEARTBEAT_STALE_MS);
  t.notThrows(() => accounts.deleteAccount(db, mel.id));
  const ada = addActiveUser(db, "ada");
  writeHeartbeat(db, Date.now());
  clearHeartbeat(db);
  t.notThrows(() => accounts.deleteAccount(db, ada.id));
});

test("the job deletes the account's keys, billing, preferences, limits and sync clients with their answers", (t) => {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  const mona = addActiveUser(db, "mona");
  const c = db.$client;
  const at = Date.now();
  for (const u of [mel, mona]) {
    c.prepare(
      "INSERT INTO api_keys (user_id, provider, sealed, last4, status, created_at, updated_at) VALUES (?, 'anthropic', 'sealed', 'abcd', 'valid', ?, ?)",
    ).run(u.id, at, at);
    c.prepare("INSERT INTO usage_billing (user_id, mode, updated_at) VALUES (?, 'key', ?)").run(
      u.id,
      at,
    );
    c.prepare(
      "INSERT INTO user_preferences (user_id, settings_json, updated_at) VALUES (?, '{}', ?)",
    ).run(u.id, at);
    c.prepare("INSERT INTO user_limits (user_id, weekly_tokens, updated_at) VALUES (?, 1, ?)").run(
      u.id,
      at,
    );
    const handle = u.handle ?? "";
    c.prepare(
      "INSERT INTO sync_clients (client_id, u, last_seq, created_at, last_used_at) VALUES (?, ?, 1, ?, ?)",
    ).run(`client-${handle}`, handle, at, at);
    c.prepare(
      "INSERT INTO sync_answers (u, mutation_id, digest, result_json, at) VALUES (?, 'm1', 'd', '{}', ?)",
    ).run(handle, at);
    c.prepare(
      "INSERT INTO sync_seq_answers (client_id, seq, digest, result_json, at) VALUES (?, 1, 'd', '{}', ?)",
    ).run(`client-${handle}`, at);
  }
  accounts.deleteAccount(db, mel.id);
  const left = (table: string, column: string, value: string) =>
    (
      c.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
        n: number;
      }
    ).n;
  for (const [table, column] of [
    ["api_keys", "user_id"],
    ["usage_billing", "user_id"],
    ["user_preferences", "user_id"],
    ["user_limits", "user_id"],
  ] as const) {
    t.is(left(table, column, mel.id), 0, table);
    t.is(left(table, column, mona.id), 1, table);
  }
  t.is(left("sync_clients", "u", "mel"), 0);
  t.is(left("sync_answers", "u", "mel"), 0);
  t.is(left("sync_seq_answers", "client_id", "client-mel"), 0);
  t.is(left("sync_clients", "u", "mona"), 1);
  t.is(left("sync_answers", "u", "mona"), 1);
  t.is(left("sync_seq_answers", "client_id", "client-mona"), 1);
});

test("the job deletes the checkpoints and resume counts of the person's runs", (t) => {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  addActiveUser(db, "mona");
  const { write, answer } = world(db);
  write("mona", "spaces.create", { id: LOUNGE, name: "lounge" });
  const mine = id();
  write("mel", "threads.create", { id: mine, space: LOUNGE, kind: "ask", q: "Mel asks", ...MODEL });
  const theirs = id();
  write("mona", "threads.create", { id: theirs, space: LOUNGE, kind: "ask", q: "Q", ...MODEL });
  const run = answer(mine, "r", "Mel's root answer");
  const monas = answer(theirs, "r", "Mona's root answer");
  const tables = new RunTables(db);
  for (const r of [run, monas]) {
    tables.putLive({
      runId: r,
      attempt: 1,
      turnId: "t",
      n: 1,
      md: `live ${r}`,
      seq: 3,
      updatedAt: 1,
    });
    tables.setResumes(r, 1, 1);
  }
  const done = accounts.deleteAccount(db, mel.id);
  t.deepEqual(done.spaces?.runs, [run]);
  t.is(tables.live(run, 1), null);
  t.is(tables.resumes(run, 1), 0);
  t.not(tables.live(monas, 1), null);
  t.is(tables.resumes(monas, 1), 1);
});

test("a deleted save is taken off its thread's count", (t) => {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  addActiveUser(db, "mona");
  const { write } = world(db);
  write("mona", "spaces.create", { id: LOUNGE, name: "lounge" });
  const p = id();
  write("mona", "threads.create", { id: p, space: LOUNGE, kind: "post", q: "Mona's post" });
  write("mel", "saved.set", { kind: "thread", id: p, on: true });
  write("mona", "saved.set", { kind: "thread", id: p, on: true });
  const store = () => new SqliteStore(db);
  t.like(store().byKey(`counts:${p}`), { saves: 2 });
  accounts.deleteAccount(db, mel.id);
  t.like(store().byKey(`counts:${p}`), { saves: 1 });
});

test("a shell the person deleted earlier, with nothing left under it, goes", (t) => {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  addActiveUser(db, "mona");
  const { write, all } = world(db);
  write("mona", "spaces.create", { id: LOUNGE, name: "lounge" });
  const p = id();
  write("mona", "threads.create", { id: p, space: LOUNGE, kind: "post", q: "Mona's post" });
  const mels = id();
  write("mel", "research.createPostFollowUp", { id: mels, thread: p, t: "Mel's reply" });
  const monas = id();
  write("mona", "research.createPostFollowUp", { id: monas, thread: p, t: "Hers", parent: mels });
  // mel deletes his reply: a shell over mona's; mona then deletes hers
  write("mel", "replies.delete", { id: mels });
  write("mona", "replies.delete", { id: monas });
  const thread = id();
  write("mel", "threads.create", { id: thread, space: LOUNGE, kind: "post", q: "Mel's post" });
  const under = id();
  write("mona", "research.createPostFollowUp", { id: under, thread, t: "Under" });
  write("mel", "threads.delete", { id: thread });
  write("mona", "replies.delete", { id: under });
  t.like(new SqliteStore(db).byKey(`reply:${mels}`), { del: true });
  t.like(new SqliteStore(db).byKey(`thread:${thread}`), { del: true, gone: false });

  accounts.deleteAccount(db, mel.id);
  const store = new SqliteStore(db);
  t.is(store.byKey(`reply:${mels}`), undefined);
  t.like(store.byKey(`thread:${thread}`), { del: true, gone: true, u: null });
  t.like(store.byKey(`counts:${p}`), { r: 0 });
  t.false(all().some((r) => JSON.stringify(r).includes('"mel"')));
});

/** Runs `fn` with `comments.delete`'s `run` replaced by one that leaves the
 * comment a shell, as the real one would, and then throws `error`. */
function withCommentsDelete(error: Error, fn: () => void) {
  const def = MUTATORS["comments.delete"];
  if (!def) throw new Error("comments.delete");
  const original = def.run;
  def.run = (tx: Tx, i: unknown) => {
    const c = tx.byKey(`comment:${(i as { id: string }).id}`);
    if (c?.kind === "comment") tx.put({ ...c, t: "", del: true });
    throw error;
  };
  try {
    fn();
  } finally {
    def.run = original;
  }
}

/** A channel where mel has a comment, a reply and a node, for the tests of
 * a failing delete. */
function melsItems(t: Parameters<typeof createFixture>[0]) {
  const { db } = createFixture(t);
  const mel = addActiveUser(db, "mel");
  addActiveUser(db, "mona");
  const w = world(db);
  w.write("mona", "spaces.create", { id: LOUNGE, name: "lounge" });
  const ask = id();
  w.write("mona", "threads.create", { id: ask, space: LOUNGE, kind: "ask", q: "Q", ...MODEL });
  w.answer(ask, "r", "An answer");
  w.write("mel", "comments.create", { id: id(), thread: ask, node: "r", t: "Mel's comment" });
  const p = id();
  w.write("mel", "threads.create", { id: p, space: LOUNGE, kind: "post", q: "Mel's post" });
  const before = w.all();
  return { db, mel, before, all: w.all };
}

test.serial("a delete that throws an error makes the job throw and change nothing", (t) => {
  const { db, mel, before, all } = melsItems(t);
  withCommentsDelete(new TypeError("a fault"), () => {
    t.throws(() => accounts.deleteAccount(db, mel.id), { message: /INTERNAL_SERVER_ERROR/ });
  });
  t.deepEqual(all(), before);
  t.not(
    (
      db.$client.prepare("SELECT provider FROM users WHERE id = ?").get(mel.id) as {
        provider: string | null;
      }
    ).provider,
    null,
  );
});

test.serial("a delete the mutator refuses makes the job throw and change nothing", (t) => {
  const { db, mel, before, all } = melsItems(t);
  withCommentsDelete(new Refusal("PRECONDITION_FAILED", "Refused here."), () => {
    t.throws(() => accounts.deleteAccount(db, mel.id), {
      message: /PRECONDITION_FAILED Refused here\./,
    });
  });
  t.deepEqual(all(), before);
});
