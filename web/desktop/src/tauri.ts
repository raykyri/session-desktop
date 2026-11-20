// The bridge in the app: Tauri's IPC. The replica is a SQLite file under the
// app's configuration directory (`~/Library/Application Support/<identifier>`
// on macOS), opened with Tauri's SQL plugin; the plugin runs each `execute`
// on a pooled connection, so a batch (one transaction) is the app's own
// command, `sql_batch`, which runs on the plugin's pool for the same file
// (`src-tauri/src/sql.rs`). The device token is one Keychain item
// (`keychain_*`, `src-tauri/src/keychain.rs`); links open with the opener
// plugin.

import type { SqlStatement, SqliteDriver } from "@session/sync/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import Database from "@tauri-apps/plugin-sql";

import type { AppAbout, DesktopBridge } from "./bridge.js";

/** The server the app talks to: set when the app is built
 * (`VITE_SESSION_SERVER`), else the production server. */
const SERVER =
  (import.meta.env["VITE_SESSION_SERVER"] as string | undefined) ?? "https://session.app";

export const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

export function tauriBridge(): DesktopBridge {
  return {
    serverOrigin: () => Promise.resolve(SERVER.replace(/\/+$/, "")),
    about: () => invoke<AppAbout>("app_about"),
    openDatabase: async (name): Promise<SqliteDriver> => {
      const db = await Database.load(`sqlite:${name}`);
      return {
        execute: async (sql, params) => void (await db.execute(sql, params ?? [])),
        select: <T>(sql: string, params?: unknown[]) => db.select<T[]>(sql, params ?? []),
        batch: (statements: readonly SqlStatement[]) =>
          invoke<void>("sql_batch", {
            db: db.path,
            statements: statements.map(([sql, params]) => [sql, params ?? []]),
          }),
      };
    },
    keychainGet: () => invoke<string | null>("keychain_get"),
    keychainSet: (value) => invoke<void>("keychain_set", { value }),
    keychainDelete: () => invoke<void>("keychain_delete"),
    openUrl: (url) => openUrl(url),
    setTitle: (title) =>
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => undefined),
  };
}
