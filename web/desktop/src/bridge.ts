// What the Desktop app needs from the machine it runs on: SQLite files under
// the app's data directory (the replica and outbox), the macOS Keychain (the
// device token), the system browser (device sign-in), the window title, and
// what the app is (the server it talks to, its name and version).
//
// Two implementations: `tauri.ts` in the app (Tauri's IPC, its SQL plugin,
// the opener plugin and the app's own Rust commands), and `testBridge.ts`
// in a browser driven by Playwright, whose Node side supplies each call
// (SQLite over better-sqlite3, a keychain in memory, a recorded "open
// browser"). Nothing else in the app reaches the machine.

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

export interface DesktopBridge {
  /** The server's origin, e.g. "https://session.app" (no trailing "/"). */
  serverOrigin(): Promise<string>;
  about(): Promise<AppAbout>;
  /** A SQLite database in a file of this name under the app's data
   * directory, made when missing. */
  openDatabase(name: string): Promise<SqliteDriver>;
  /** The device's sign-in, kept in the macOS Keychain: one item, as JSON
   * text, or null when there is none. */
  keychainGet(): Promise<string | null>;
  keychainSet(value: string): Promise<void>;
  keychainDelete(): Promise<void>;
  /** Open a link in the system browser. */
  openUrl(url: string): Promise<void>;
  /** The window's title (the macOS title bar). */
  setTitle(title: string): void;
}
