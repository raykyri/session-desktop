// The bridge in the app: Tauri's IPC. The replica is the app's own
// commands (`src-tauri/src/replica.rs`): the page names it by the person's
// handle, never by a path, and each call is one statement (`replica_select`)
// or one transaction (`replica_batch`). The device token is one Keychain
// item (`keychain_*`, `src-tauri/src/keychain.rs`); links open with the
// opener plugin, for http, https and mailto only.

import type { SqlStatement, SqliteDriver } from "@session/sync/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

import { replicaError, type AppAbout, type DesktopBridge } from "./bridge.js";

/** The server the app talks to: set when the app is built
 * (`VITE_SESSION_SERVER`), else the production server. */
const SERVER =
  (import.meta.env["VITE_SESSION_SERVER"] as string | undefined) ?? "https://session.app";

export const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

/** A replica command, its refusal as a `ReplicaError`. */
const replica = <T>(cmd: string, args: Record<string, unknown>) =>
  invoke<T>(cmd, args).catch((e: unknown) => {
    throw replicaError(e);
  });

export function tauriBridge(): DesktopBridge {
  return {
    serverOrigin: () => Promise.resolve(SERVER.replace(/\/+$/, "")),
    about: () => invoke<AppAbout>("app_about"),
    openReplica: async (handle): Promise<SqliteDriver> => {
      await replica<void>("replica_open", { handle });
      const batch = (statements: readonly SqlStatement[]) =>
        replica<void>("replica_batch", {
          handle,
          statements: statements.map(([sql, params]) => [sql, params ?? []]),
        });
      return {
        execute: (sql, params) => batch([[sql, params ?? []]]),
        select: <T>(sql: string, params?: unknown[]) =>
          replica<T[]>("replica_select", { handle, sql, params: params ?? [] }),
        batch,
      };
    },
    deleteReplica: (handle) => replica<void>("replica_delete", { handle }),
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
