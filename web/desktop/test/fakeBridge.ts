// A bridge in the test's process: the replicas over better-sqlite3 (in
// memory, or files in `dir` held with an exclusive lock as the app's
// commands hold them), a Keychain item, and the links opened.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { SqlStatement, SqliteDriver } from "@session/sync/client";
import BetterSqlite from "better-sqlite3";

import { ReplicaError, type DesktopBridge } from "../src/bridge.js";
import { replicaFile } from "../src/platform.js";

export class FakeBridge implements DesktopBridge {
  keychain: string | null = null;
  readonly opened: string[] = [];
  /** The replicas open, by handle. */
  private readonly dbs = new Map<string, BetterSqlite.Database>();
  /** The handles whose replica was deleted, in order. */
  readonly deleted: string[] = [];
  title = "";
  origin = "https://session.test";
  /** The next opens of a replica fail with this (then it opens). */
  failOpen: ReplicaError[] = [];
  /** `keychainSet` fails (the Keychain refused the item). */
  keychainFails = false;
  /** `openUrl` fails (the browser could not be opened). */
  openFails = false;

  /** `dir`: the replicas are files there (null: in memory). */
  constructor(readonly dir: string | null = null) {}

  serverOrigin = () => Promise.resolve(this.origin);
  about = () =>
    Promise.resolve({ name: "MacBook Air", device: "MacBook Air · macOS 15.1", app: "Session" });
  hasReplica(handle: string): boolean {
    return this.dbs.has(handle);
  }
  /** The open replica's connection (the test's own reads). */
  replica(handle: string): BetterSqlite.Database | undefined {
    return this.dbs.get(handle);
  }
  private open(handle: string): BetterSqlite.Database {
    let db = this.dbs.get(handle);
    if (db) return db;
    if (!this.dir) {
      db = new BetterSqlite(":memory:");
    } else {
      db = new BetterSqlite(join(this.dir, replicaFile(handle)), { timeout: 0 });
      try {
        db.pragma("locking_mode = EXCLUSIVE");
        db.exec("BEGIN EXCLUSIVE; COMMIT;");
      } catch {
        db.close();
        throw new ReplicaError("LOCKED", "another copy of Session is using this replica");
      }
    }
    this.dbs.set(handle, db);
    return db;
  }
  openReplica(handle: string): Promise<SqliteDriver> {
    const fail = this.failOpen.shift();
    if (fail) return Promise.reject(fail);
    let db: BetterSqlite.Database;
    try {
      db = this.open(handle);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const args = (p?: readonly unknown[]) => (p ?? []) as unknown[];
    const live = () => {
      if (this.dbs.get(handle) !== db) throw new ReplicaError("NOT_OPEN", "not open");
      return db;
    };
    return Promise.resolve({
      execute: async (sql, params) =>
        void live()
          .prepare(sql)
          .run(...args(params)),
      select: async <T>(sql: string, params?: unknown[]) =>
        live()
          .prepare(sql)
          .all(...args(params)) as T[],
      batch: async (statements: readonly SqlStatement[]) => {
        const d = live();
        d.transaction(() => {
          for (const [sql, p] of statements) d.prepare(sql).run(...args(p));
        })();
      },
    });
  }
  deleteReplica(handle: string): Promise<void> {
    this.deleted.push(handle);
    this.dbs.get(handle)?.close();
    this.dbs.delete(handle);
    if (this.dir)
      for (const suffix of ["", "-journal"]) {
        const f = join(this.dir, `${replicaFile(handle)}${suffix}`);
        if (existsSync(f)) rmSync(f);
      }
    return Promise.resolve();
  }
  /** This copy of the app quits: its replicas close. */
  quit(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
  keychainGet = () => Promise.resolve(this.keychain);
  keychainSet = (v: string) =>
    this.keychainFails
      ? Promise.reject(new Error("The Keychain refused the item."))
      : Promise.resolve(void (this.keychain = v));
  keychainDelete = () => Promise.resolve(void (this.keychain = null));
  openUrl = (url: string) =>
    this.openFails
      ? Promise.reject(new Error("Not allowed to open url"))
      : Promise.resolve(void this.opened.push(url));
  setTitle = (t: string) => void (this.title = t);
}
