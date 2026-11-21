// The privacy check after a removal (plan `04` P2, `05` M6 exit criteria;
// the storage scan of `01` D4): the removed text must be absent from the
// SQLite file, its WAL and Litestream's local state beside them, from the
// snapshot and pull answers the server gives the channel's owner, a member,
// a non-member, a signed-out reader and the author, and from the author's
// `removed` notification.
//
// Read-only on the records: the reads go through a `SyncServer` over a
// read-only connection, so it runs next to the live server (`fly ssh
// console`, `web/docs/runbooks/privacy-check.md`). A pull starts from a
// cursor at the version just before the removal, as a reader who had read
// the thread before it was removed holds; the cursor is sealed with the
// configured cursor key, so the server would accept it. A pull that answers
// resync proves nothing about the removal, so it fails its check.
//
// The text is looked for as it is stored: a record body is JSON, where a
// quote, a backslash or a line break of the text is escaped, so the files
// are searched for the raw text and for its JSON-escaped form; served
// answers are searched string by string, after parsing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { SqliteStore } from "@session/db";
import {
  MUTATORS,
  isHandle,
  threadKey,
  view,
  type LogId,
  type StoredRecord,
} from "@session/mutators";
import { SyncServer, Tokens, type CursorKeys } from "@session/sync/server";
import SqliteDatabase from "better-sqlite3";

export interface PrivacyCheckInput {
  /** The database file (`session.db`); its WAL is `<path>-wal`. */
  path: string;
  /** The removed thread's id. */
  thread: string;
  /** A piece of the removed text: the question, an answer or a reply. */
  text: string;
  /** The server's cursor keys, so the pull's cursor is one it accepts. */
  cursorKeys?: CursorKeys;
  /** A handle that is not a member of the channel, for the non-member's
   * reads (any valid handle; it need not be an account). */
  outsider?: string;
}

export interface PrivacyCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PrivacyCheckReport {
  ok: boolean;
  checks: PrivacyCheckResult[];
}

const OUTSIDER = "privacy.check";

/** The byte strings the text is stored as: raw, and escaped as a JSON
 * string (a record body), when that differs. */
function needles(text: string): Buffer[] {
  const escaped = JSON.stringify(text).slice(1, -1);
  return [...new Set([text, escaped])].map((s) => Buffer.from(s, "utf8"));
}

/** Whether a file's bytes hold the text in any of its stored forms. */
function fileHolds(file: string, text: string): boolean {
  if (!existsSync(file)) return false;
  const bytes = readFileSync(file);
  return needles(text).some((n) => bytes.indexOf(n) !== -1);
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Litestream's local state beside the database: `.<name>-litestream/`
 * (its shadow WAL under 0.3, its LTX files under 0.5). */
export const litestreamDir = (path: string) => join(dirname(path), `.${basename(path)}-litestream`);

/** Whether a served value (a snapshot or a pull, parsed) holds the text in
 * any of its strings. */
export function holdsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) return value.some((v) => holdsText(v, text));
  if (value !== null && typeof value === "object")
    return Object.values(value).some((v) => holdsText(v, text));
  return false;
}

/** Runs every check; `ok` only when all pass. */
export function privacyCheck(input: PrivacyCheckInput): PrivacyCheckReport {
  const checks: PrivacyCheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });

  // The WAL holds earlier page images until a checkpoint resets it: a
  // TRUNCATE checkpoint first, from its own connection. A reader that holds
  // the WAL open (Litestream) can keep it from resetting the WAL; the scans
  // of the file and the WAL below decide whether that left the text there.
  const writer = new SqliteDatabase(input.path, { fileMustExist: true });
  let busy = true;
  try {
    writer.pragma("busy_timeout = 5000");
    const [row] = writer.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    busy = row?.busy !== 0;
  } finally {
    writer.close();
  }
  const wal = `${input.path}-wal`;
  const inFile = fileHolds(input.path, input.text);
  const inWal = fileHolds(wal, input.text);
  check(
    "the WAL was checkpointed",
    !busy || (!inFile && !inWal),
    busy
      ? "busy: a reader holds the WAL (Litestream); see the scans of the file and WAL"
      : undefined,
  );
  check(`the text is not in ${input.path}`, !inFile);
  check(`the text is not in ${wal}`, !inWal);
  const shadow = litestreamDir(input.path);
  if (existsSync(shadow)) {
    const holding = filesUnder(shadow).filter((f) => fileHolds(f, input.text));
    check(
      `the text is not in ${shadow}`,
      holding.length === 0,
      holding.length ? holding.join(", ") : undefined,
    );
  }

  const db = new SqliteDatabase(input.path, { readonly: true, fileMustExist: true });
  try {
    const store = new SqliteStore(db);
    const server = new SyncServer({
      store,
      clock: { now: Date.now },
      mutators: MUTATORS,
      ...(input.cursorKeys ? { cursorKeys: input.cursorKeys } : {}),
    });
    const tokens = new Tokens(input.cursorKeys);
    const thread = store.byKey(threadKey(input.thread));
    if (thread?.kind !== "thread") {
      check("the thread exists", false, `no record thread:${input.thread}`);
      return { ok: false, checks };
    }
    check("the thread is removed", thread.mod === "removed", `mod: ${String(thread.mod)}`);
    const sp = thread.s;
    const log: LogId = `space:${sp}`;
    const space = store.byKey(`space:${sp}`);
    const owner = space?.kind === "space" ? space.owner : null;
    const author = thread.u;
    const member = [...store.keysIn("member", { sp })]
      .map((k) => store.byKey(k))
      .find(
        (m): m is Extract<StoredRecord, { kind: "member" }> =>
          m?.kind === "member" && m.u !== owner && m.u !== author,
      );
    const outsider = input.outsider ?? OUTSIDER;
    if (!isHandle(outsider)) throw new Error(`not a handle: ${outsider}`);
    const readers: [string, string | null][] = [
      ["the owner", owner],
      ["a member", member?.u ?? null],
      ["a non-member", outsider],
      ["a signed-out reader", null],
      ["the author", author],
    ];
    // the version of the removal's commit: the thread's last log row
    const removedAt = store.logRow(log, threadKey(thread.id))?.version ?? 1;
    const now = Date.now();
    for (const [who, u] of readers) {
      if (who === "a member" && u === null) {
        check("a member's reads", false, "the channel has no member besides the owner and author");
        continue;
      }
      if ((who === "the owner" || who === "the author") && u === null) continue;
      const actor = u === null ? null : { u };
      const snap = server.snapshot(actor, log);
      check(`${who}'s snapshot holds no removed text`, !holdsText(snap, input.text));
      if (u !== author) {
        const served = snap.records.find((r) => r.key === threadKey(thread.id))?.record;
        check(
          `${who}'s snapshot names no author of the removed thread`,
          served === undefined || (served.kind === "thread" && served.u === null),
        );
      }
      const cursor = tokens.seal({
        log,
        u,
        n: store.epoch(log).n,
        v: removedAt - 1,
        h: store.head(),
        at: now,
        hid: store.history(),
      });
      const pulled = server.pull(actor, log, cursor);
      const resync = "resync" in pulled;
      check(
        `${who}'s pull from before the removal holds no removed text`,
        !resync && !holdsText(pulled, input.text),
        resync ? "the pull answered resync" : undefined,
      );
      // a reader who may read the thread is served its removal
      if (!resync && view(store, thread, u) !== null)
        check(
          `${who}'s pull from before the removal carries the removal`,
          pulled.changes.some((c) => c.key === threadKey(thread.id)),
        );
    }
    if (author !== null) {
      const own = server.snapshot({ u: author }, `user:${author}`);
      const notes = own.records
        .map((r) => r.record)
        .filter((r) => r?.kind === "notif" && r.type === "removed" && r.th === thread.id);
      check("the author has the removed notification", notes.length === 1);
      check("the removed notification holds no removed text", !holdsText(notes, input.text));
    }
  } finally {
    db.close();
  }
  return { ok: checks.every((c) => c.ok), checks };
}
