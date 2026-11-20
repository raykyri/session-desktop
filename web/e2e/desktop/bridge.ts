// The Node side of the Desktop app's test bridge (`web/desktop/src/
// testBridge.ts`): what Tauri and macOS give the app, in the test's process.
// - the replicas: SQLite files (better-sqlite3) in a directory, named by
//   the person's handle as the app's `replica_*` commands name them
//   (`src-tauri/src/replica.rs`), each held with an exclusive lock, so a
//   second bridge on the same directory (a second copy of the app) is
//   refused LOCKED; the statements the commands refuse are refused here
//   too, and `batch` is one transaction;
// - the Keychain: one item in memory;
// - the system browser: the links the app opened, recorded;
// - the window's title.
// The page reaches it through one exposed function (`__sessionBridge`),
// which stays installed across reloads of the page; a new page (the app
// started again) installs the same bridge, and finds the same files and
// Keychain item.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import BetterSqlite from "better-sqlite3";

import { APP_ORIGIN } from "../constants.js";

type Params = (string | number | null)[];

/** A replica call the app's commands refuse (`{ code, message }`). */
class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The replica's file for a handle, as `replica.rs`'s `file_name`. */
export function replicaName(handle: string): string {
  if (!HANDLE.test(handle)) throw new Refused("REFUSED", "not a handle");
  return `replica-${handle}.sqlite`;
}

/** The statements the app's commands run (`replica.rs`'s
 * `check_statement`): one statement starting with SELECT, INSERT, UPDATE,
 * DELETE, REPLACE, CREATE or DROP, or `PRAGMA user_version`. */
export function checkStatement(sql: string): void {
  const s = sql.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  const word = (/^[A-Za-z]+/.exec(s)?.[0] ?? "").toUpperCase();
  const ok =
    ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP"].includes(word) ||
    (word === "PRAGMA" && /^PRAGMA\s+user_version\b/i.test(s));
  const tail = sql.replace(/'[^']*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\//g, "").split(";");
  if (!ok || tail.slice(1).some((x) => x.trim() !== ""))
    throw new Refused("REFUSED", `the replica's commands do not run ${JSON.stringify(word)}`);
}

export class TestBridge {
  readonly dir: string;
  /** The replicas this bridge (this copy of the app) holds open. */
  private readonly open = new Map<string, BetterSqlite.Database>();
  /** The Keychain item (JSON text), or null. */
  keychain: string | null = null;
  /** The links the app opened in the browser, in order. */
  readonly opened: string[] = [];
  /** Opening a link fails (the browser could not be started). */
  openFails = false;
  title = "";

  constructor(
    readonly about = {
      name: "MacBook Air",
      device: "MacBook Air · macOS 15.1",
      app: "Session for Mac 0.1.0",
    },
    /** Another copy's directory: the same files (a second app instance). */
    dir?: string,
  ) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), "session-desktop-e2e-"));
  }

  /** The app's page uses this bridge (before the page loads). */
  async install(page: Page): Promise<void> {
    await page.exposeFunction("__sessionBridge", (op: string, args: unknown[]) =>
      this.handle(op, args),
    );
  }

  /** Whether the replica file of `name` exists. */
  exists(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  /** `f` over a connection for the test's own reads and writes: the app's
   * when it holds the file, else one of the test's. A file that is gone
   * reads as an empty replica (the client's tables, no rows). */
  private withDb<T>(name: string, f: (db: BetterSqlite.Database) => T): T {
    const handle = /^replica-(.*)\.sqlite$/.exec(name)?.[1] ?? "";
    const held = this.open.get(handle);
    if (held) return f(held);
    const gone = !this.exists(name);
    const db = new BetterSqlite(gone ? ":memory:" : join(this.dir, name), { timeout: 0 });
    try {
      if (gone)
        for (const t of [
          "sync_client_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
          "sync_client_logs (log TEXT PRIMARY KEY, cursor TEXT, frozen INTEGER NOT NULL)",
          "sync_client_records (log TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL)",
          "sync_client_outbox (pos INTEGER PRIMARY KEY, body TEXT NOT NULL)",
        ])
          db.exec(`CREATE TABLE ${t}`);
      return f(db);
    } finally {
      db.close();
    }
  }

  /** The rows of a query on one of the app's files (the test's checks). */
  query<T>(name: string, sql: string, params: Params = []): T[] {
    return this.withDb(name, (db) => db.prepare(sql).all(...params) as T[]);
  }

  /** A statement on one of the app's files (the test's own writes). */
  run(name: string, sql: string, params: Params = []): void {
    this.withDb(name, (db) => db.prepare(sql).run(...params));
  }

  /** Open and lock the person's replica, as `replica_open`. */
  private openReplica(handle: string): void {
    const name = replicaName(handle);
    if (this.open.has(handle)) return;
    const db = new BetterSqlite(join(this.dir, name), { timeout: 0 });
    try {
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
    } catch (e) {
      db.close();
      const code = (e as { code?: string }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
        throw new Refused("LOCKED", "another copy of Session is using this replica");
      throw new Refused("FAILED", e instanceof Error ? e.message : String(e));
    }
    this.open.set(handle, db);
  }

  private held(handle: string): BetterSqlite.Database {
    replicaName(handle);
    const db = this.open.get(handle);
    if (!db) throw new Refused("NOT_OPEN", "the replica is not open");
    return db;
  }

  private closeReplica(handle: string): void {
    this.open.get(handle)?.close();
    this.open.delete(handle);
  }

  private replicaCall(op: string, args: unknown[]): unknown {
    const handle = args[0] as string;
    switch (op) {
      case "replica.open":
        this.openReplica(handle);
        return null;
      case "replica.select": {
        const [, sql, params] = args as [string, string, Params];
        checkStatement(sql);
        return this.held(handle)
          .prepare(sql)
          .all(...params);
      }
      case "replica.batch": {
        const [, statements] = args as [string, [string, Params][]];
        for (const [sql] of statements) checkStatement(sql);
        const db = this.held(handle);
        db.transaction(() => {
          for (const [sql, params] of statements) db.prepare(sql).run(...params);
        })();
        return null;
      }
      case "replica.delete": {
        const name = replicaName(handle);
        this.closeReplica(handle);
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          rmSync(join(this.dir, `${name}${suffix}`), { force: true });
        return null;
      }
    }
    throw new Error(`unknown bridge call ${op}`);
  }

  private handle(op: string, args: unknown[]): unknown {
    if (op.startsWith("replica."))
      try {
        return this.replicaCall(op, args);
      } catch (e) {
        if (e instanceof Refused) return { replicaError: { code: e.code, message: e.message } };
        return {
          replicaError: { code: "FAILED", message: e instanceof Error ? e.message : String(e) },
        };
      }
    switch (op) {
      case "serverOrigin":
        return APP_ORIGIN;
      case "about":
        return this.about;
      case "keychain.get":
        return this.keychain;
      case "keychain.set":
        this.keychain = args[0] as string;
        return null;
      case "keychain.delete":
        this.keychain = null;
        return null;
      case "openUrl":
        if (this.openFails) throw new Error("the browser could not be opened");
        this.opened.push(args[0] as string);
        return null;
      case "setTitle":
        this.title = args[0] as string;
        return null;
    }
    throw new Error(`unknown bridge call ${op}`);
  }

  /** The app quits: its replicas close (their locks go). */
  quit(): void {
    for (const h of [...this.open.keys()]) this.closeReplica(h);
  }

  close(): void {
    this.quit();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
