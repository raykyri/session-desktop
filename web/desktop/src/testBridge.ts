// The bridge in a browser that Playwright drives (the desktop-mode e2e,
// `web/e2e/desktop/`): every call goes to one function the test exposes on
// the page (`page.exposeFunction("__sessionBridge", …)`), whose Node side
// keeps the SQLite files (better-sqlite3), the keychain item and the links
// the app opened. They live in the test's process, so they outlive a reload
// of the page as the app's files outlive a restart.

import type { SqlStatement, SqliteDriver } from "@session/sync/client";

import type { AppAbout, DesktopBridge } from "./bridge.js";

/** The function the test exposes: an operation and its arguments. */
export type BridgeCall = (op: string, args: unknown[]) => Promise<unknown>;

declare global {
  interface Window {
    __sessionBridge?: BridgeCall;
  }
}

/** The exposed function, when the page runs under the test. */
export function testBridgeCall(): BridgeCall | null {
  return typeof window !== "undefined" && typeof window.__sessionBridge === "function"
    ? window.__sessionBridge
    : null;
}

export function testBridge(call: BridgeCall): DesktopBridge {
  const driver = (name: string): SqliteDriver => ({
    execute: async (sql, params) => void (await call("sql.execute", [name, sql, params ?? []])),
    select: async <T>(sql: string, params?: unknown[]) =>
      (await call("sql.select", [name, sql, params ?? []])) as T[],
    batch: async (statements: readonly SqlStatement[]) =>
      void (await call("sql.batch", [name, statements.map(([s, p]) => [s, p ?? []])])),
  });
  return {
    serverOrigin: async () => (await call("serverOrigin", [])) as string,
    about: async () => (await call("about", [])) as AppAbout,
    openDatabase: async (name) => {
      await call("sql.open", [name]);
      return driver(name);
    },
    keychainGet: async () => (await call("keychain.get", [])) as string | null,
    keychainSet: async (value) => void (await call("keychain.set", [value])),
    keychainDelete: async () => void (await call("keychain.delete", [])),
    openUrl: async (url) => void (await call("openUrl", [url])),
    setTitle: (title) => void call("setTitle", [title]).catch(() => undefined),
  };
}
