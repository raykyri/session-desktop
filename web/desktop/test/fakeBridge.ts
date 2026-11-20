// A bridge in the test's process: SQLite over better-sqlite3 (in memory),
// a Keychain item, and the links opened.

import type { SqlStatement, SqliteDriver } from "@session/sync/client";
import BetterSqlite from "better-sqlite3";

import type { DesktopBridge } from "../src/bridge.js";

export class FakeBridge implements DesktopBridge {
  keychain: string | null = null;
  readonly opened: string[] = [];
  private readonly dbs = new Map<string, BetterSqlite.Database>();
  title = "";
  origin = "https://session.test";

  serverOrigin = () => Promise.resolve(this.origin);
  about = () =>
    Promise.resolve({ name: "MacBook Air", device: "MacBook Air · macOS 15.1", app: "Session" });
  hasDatabase(name: string): boolean {
    return this.dbs.has(name);
  }
  private db(name: string) {
    let db = this.dbs.get(name);
    if (!db) this.dbs.set(name, (db = new BetterSqlite(":memory:")));
    return db;
  }
  openDatabase(name: string): Promise<SqliteDriver> {
    const db = this.db(name);
    const args = (p?: readonly unknown[]) => (p ?? []) as unknown[];
    return Promise.resolve({
      execute: (sql, params) => Promise.resolve(void db.prepare(sql).run(...args(params))),
      select: <T>(sql: string, params?: unknown[]) =>
        Promise.resolve(db.prepare(sql).all(...args(params)) as T[]),
      batch: (statements: readonly SqlStatement[]) =>
        Promise.resolve(
          db.transaction(() => {
            for (const [sql, p] of statements) db.prepare(sql).run(...args(p));
          })(),
        ),
    });
  }
  keychainGet = () => Promise.resolve(this.keychain);
  keychainSet = (v: string) => Promise.resolve(void (this.keychain = v));
  keychainDelete = () => Promise.resolve(void (this.keychain = null));
  openUrl = (url: string) => Promise.resolve(void this.opened.push(url));
  setTitle = (t: string) => void (this.title = t);
}
