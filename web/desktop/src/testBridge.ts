// The bridge in a browser that Playwright drives (the desktop-mode e2e,
// `web/e2e/desktop/`): every call goes to one function the test exposes on
// the page (`page.exposeFunction("__sessionBridge", …)`), whose Node side
// keeps the replica files (better-sqlite3, locked as the app's commands
// lock them), the keychain item and the links the app opened. They live in
// the test's process, so they outlive a reload of the page as the app's
// files outlive a restart.

import type { SqlStatement, SqliteDriver } from "@session/sync/client";

import { ReplicaError, type AppAbout, type DesktopBridge } from "./bridge.js";

/** The function the test exposes: an operation and its arguments. A
 * refusal of a replica call answers `{ replicaError: { code, message } }`
 * (an exposed function's exception reaches the page as its message only). */
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
  /** A replica call; its refusal as a `ReplicaError`. */
  const replica = async (op: string, args: unknown[]) => {
    const r = (await call(op, args)) as { replicaError?: { code: string; message: string } } | null;
    if (r && typeof r === "object" && r.replicaError)
      throw new ReplicaError(r.replicaError.code, r.replicaError.message);
    return r;
  };
  const driver = (handle: string): SqliteDriver => {
    const batch = async (statements: readonly SqlStatement[]) =>
      void (await replica("replica.batch", [handle, statements.map(([s, p]) => [s, p ?? []])]));
    return {
      execute: (sql, params) => batch([[sql, params ?? []]]),
      select: async <T>(sql: string, params?: unknown[]) =>
        (await replica("replica.select", [handle, sql, params ?? []])) as T[],
      batch,
    };
  };
  return {
    serverOrigin: async () => (await call("serverOrigin", [])) as string,
    about: async () => (await call("about", [])) as AppAbout,
    openReplica: async (handle) => {
      await replica("replica.open", [handle]);
      return driver(handle);
    },
    deleteReplica: async (handle) => void (await replica("replica.delete", [handle])),
    keychainGet: async () => (await call("keychain.get", [])) as string | null,
    keychainSet: async (value) => void (await call("keychain.set", [value])),
    keychainDelete: async () => void (await call("keychain.delete", [])),
    openUrl: async (url) => void (await call("openUrl", [url])),
    setTitle: (title) => void call("setTitle", [title]).catch(() => undefined),
  };
}
