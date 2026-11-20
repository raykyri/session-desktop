// What the Desktop app needs from the machine it runs on: the person's
// replica (one SQLite file under the app's data directory, named by their
// handle), the macOS Keychain (the device token), the system browser
// (device sign-in), the window title, and what the app is (the server it
// talks to, its name and version).
//
// Two implementations: `tauri.ts` in the app (Tauri's IPC: the app's own
// Rust commands and the opener plugin), and `testBridge.ts` in a browser
// driven by Playwright, whose Node side supplies each call (SQLite over
// better-sqlite3, a keychain in memory, a recorded "open browser").
// Nothing else in the app reaches the machine.

import type { SqliteDriver } from "@session/sync/client";

/** What the app tells the server about itself (`devices.authorize`). */
export interface AppAbout {
  /** The device's name ("MacBook Air"). */
  name: string;
  /** The device as the browser's approval page shows it ("MacBook Air ·
   * macOS 15.1"). */
  device: string;
  /** The app and its version ("Session for Mac 1.0.0"). */
  app: string;
}

/** A replica call the bridge refused: `code` LOCKED (another copy of the
 * app holds the file), REFUSED (not a handle, or a statement the replica's
 * commands do not run), NOT_OPEN, or FAILED (SQLite's own error). */
export class ReplicaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplicaError";
  }
}

/** A bridge's rejection as a `ReplicaError` (Tauri's commands reject with
 * `{ code, message }`); anything else is FAILED. */
export function replicaError(e: unknown): ReplicaError {
  if (e instanceof ReplicaError) return e;
  const o = (e !== null && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown };
  const message =
    typeof o.message === "string" ? o.message : e instanceof Error ? e.message : String(e);
  return new ReplicaError(typeof o.code === "string" ? o.code : "FAILED", message);
}

export interface DesktopBridge {
  /** The server's origin, e.g. "https://session.app" (no trailing "/"). */
  serverOrigin(): Promise<string>;
  about(): Promise<AppAbout>;
  /** The person's replica: the file `replica-<handle>.sqlite` under the
   * app's data directory (the bridge makes the name; the page never names
   * a path), made when missing, and held by this process: another copy of
   * the app is refused (`ReplicaError` LOCKED). */
  openReplica(handle: string): Promise<SqliteDriver>;
  /** Close the person's replica and delete its file and journal. */
  deleteReplica(handle: string): Promise<void>;
  /** The device's sign-in, kept in the macOS Keychain: one item, as JSON
   * text, or null when there is none. */
  keychainGet(): Promise<string | null>;
  keychainSet(value: string): Promise<void>;
  keychainDelete(): Promise<void>;
  /** Open a link in the system browser (http, https and mailto). */
  openUrl(url: string): Promise<void>;
  /** The window's title (the macOS title bar). */
  setTitle(title: string): void;
}
