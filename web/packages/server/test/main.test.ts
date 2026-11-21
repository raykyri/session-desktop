// `main.ts` in this process: the database open of the boot (the first
// heartbeat, the refusal of a database this build cannot run on) and the
// shutdown's deletion of the heartbeat (`runbooks/reset-database.md`,
// `runbooks/delete-account.md`).

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HEARTBEAT_KEY, closeDatabase, runningServer } from "@session/db";
import test from "ava";
import SqliteDatabase from "better-sqlite3";

import { createLogger } from "../src/logger.js";
import { main, openServerDatabase } from "../src/main.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function tempDir(t: { teardown(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "session-main-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The heartbeat row, read over a connection of its own. */
function heartbeatRow(path: string): unknown {
  const c = new SqliteDatabase(path, { readonly: true });
  try {
    return c.prepare("SELECT value FROM server_meta WHERE key = ?").get(HEARTBEAT_KEY);
  } finally {
    c.close();
  }
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const exit = (code: number): never => {
  throw new Exited(code);
};

test("R1: the server's open writes the first heartbeat before the boot steps", (t) => {
  const path = join(tempDir(t), "session.db");
  const silent = createLogger({ level: "error", write: () => undefined });
  const db = openServerDatabase(path, silent, exit);
  t.not(runningServer(db, Date.now()), null);
  closeDatabase(db);
});

test("R6: a database from before the squash logs one line naming the reset runbook and exits 1", (t) => {
  const path = join(tempDir(t), "session.db");
  // the earlier history: six migrations this build does not know
  const old = new SqliteDatabase(path);
  old.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)",
  );
  for (let k = 0; k < 6; k++)
    old
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(String(k).repeat(64), 1_700_000_000_000 + k);
  old.close();
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  const error = t.throws(() => openServerDatabase(path, logger, exit), { instanceOf: Exited });
  t.is(error?.code, 1);
  t.is(lines.length, 1);
  const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  t.is(line["level"], "error");
  t.regex(String(line["message"]), /6 unrecognized migration\(s\)/);
  t.regex(String(line["message"]), /web\/docs\/runbooks\/reset-database\.md/);
  t.false(lines[0]?.includes("stack") ?? true, "no stack trace");
  t.false(lines[0]?.includes("    at ") ?? true, "no stack trace");
});

test.serial("S4: main() writes the heartbeat and its shutdown deletes it", async (t) => {
  const dir = tempDir(t);
  const saved = { ...process.env };
  t.teardown(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env["LITESTREAM_REPLICA_URL"];
  delete process.env["SESSION_DOCUMENTS_REPLICA_URL"];
  Object.assign(process.env, {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(await freePort()),
    SESSION_PUBLIC_ORIGIN: "http://localhost:8787",
    SESSION_DATA_DIR: dir,
  });
  const path = join(dir, "session.db");
  const running = main();
  t.like(heartbeatRow(path), { value: `pid ${process.pid}` });
  await running.close();
  t.is(heartbeatRow(path), undefined);
});
