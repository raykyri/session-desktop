// The Node side of the Desktop app's test bridge (`web/desktop/src/
// testBridge.ts`): what Tauri and macOS give the app, in the test's process.
// - SQLite files (better-sqlite3) in a temp directory, opened by name, with
//   `batch` as one transaction, as the app's `sql_batch` command runs it;
// - the Keychain: one item in memory;
// - the system browser: the links the app opened, recorded;
// - the window's title.
// The page reaches it through one exposed function (`__sessionBridge`),
// which stays installed across reloads of the page; a new page (the app
// started again) installs the same bridge, and finds the same files and
// Keychain item.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import BetterSqlite from "better-sqlite3";

import { APP_ORIGIN } from "../constants.js";

type Params = (string | number | null)[];

export class TestBridge {
  readonly dir = mkdtempSync(join(tmpdir(), "session-desktop-e2e-"));
  private readonly dbs = new Map<string, BetterSqlite.Database>();
  /** The Keychain item (JSON text), or null. */
  keychain: string | null = null;
  /** The links the app opened in the browser, in order. */
  readonly opened: string[] = [];
  title = "";

  constructor(
    readonly about = {
      name: "MacBook Air",
      device: "MacBook Air · macOS 15.1",
      app: "Session for Mac 0.1.0",
    },
  ) {}

  /** The app's page uses this bridge (before the page loads). */
  async install(page: Page): Promise<void> {
    await page.exposeFunction("__sessionBridge", (op: string, args: unknown[]) =>
      this.handle(op, args),
    );
  }

  private db(name: string): BetterSqlite.Database {
    let db = this.dbs.get(name);
    if (!db) {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`bad database name ${name}`);
      db = new BetterSqlite(join(this.dir, name));
      this.dbs.set(name, db);
    }
    return db;
  }

  /** The rows of a query on one of the app's files (the test's checks). */
  query<T>(name: string, sql: string, params: Params = []): T[] {
    return this.db(name)
      .prepare(sql)
      .all(...params) as T[];
  }

  private handle(op: string, args: unknown[]): unknown {
    switch (op) {
      case "serverOrigin":
        return APP_ORIGIN;
      case "about":
        return this.about;
      case "sql.open":
        this.db(args[0] as string);
        return null;
      case "sql.execute": {
        const [name, sql, params] = args as [string, string, Params];
        this.db(name)
          .prepare(sql)
          .run(...params);
        return null;
      }
      case "sql.select": {
        const [name, sql, params] = args as [string, string, Params];
        return this.db(name)
          .prepare(sql)
          .all(...params);
      }
      case "sql.batch": {
        const [name, statements] = args as [string, [string, Params][]];
        const db = this.db(name);
        db.transaction(() => {
          for (const [sql, params] of statements) db.prepare(sql).run(...params);
        })();
        return null;
      }
      case "keychain.get":
        return this.keychain;
      case "keychain.set":
        this.keychain = args[0] as string;
        return null;
      case "keychain.delete":
        this.keychain = null;
        return null;
      case "openUrl":
        this.opened.push(args[0] as string);
        return null;
      case "setTitle":
        this.title = args[0] as string;
        return null;
    }
    throw new Error(`unknown bridge call ${op}`);
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
