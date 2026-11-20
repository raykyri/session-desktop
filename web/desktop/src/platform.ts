// The Desktop app's platform for the client (`@session/client/shell`'s
// `Platform`), over a bridge (`bridge.ts`):
//
// - the sign-in is one Keychain item: the device token, the device's id, the
//   person's handle and their account as last read (`/api/me`), so the app
//   starts offline from its replica;
// - requests go to the server's origin with `Authorization: Bearer <token>`
//   and no cookie; an answer is bound to the token it was asked with, so an
//   answer that arrives after another sign-in changes nothing of it;
// - each person's replica and outbox are one SQLite file
//   (`replica-<handle>.sqlite`, which the bridge names) behind
//   `SqliteStorage`, with `persist: true`; signing out closes it and
//   deletes the file, and so does a token the server no longer takes
//   (revoked or expired), which returns to the sign-in;
// - a replica that cannot be opened (another copy of the app holds it, or
//   SQLite failed) shows the storage problem, with Try again and, unless
//   another copy holds it, Reset;
// - the window's title follows the page's (`document.title`).

import type { Platform } from "@session/client/shell";
import {
  SqliteStorage,
  type OutboxEntry,
  type SqlStatement,
  type SqliteDriver,
} from "@session/sync/client";

import { replicaError, type DesktopBridge } from "./bridge.js";

/** The Keychain item, as JSON. */
export interface SignedIn {
  token: string;
  /** The device record's id (`devices.token`'s answer). */
  device: string;
  /** The person's handle: whose replica this device holds. */
  handle: string;
  /** `/api/me` as last read. */
  me: unknown;
}

const isSignedIn = (v: unknown): v is SignedIn =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as SignedIn).token === "string" &&
  typeof (v as SignedIn).device === "string" &&
  typeof (v as SignedIn).handle === "string";

/** The replica's file name for a person, as the bridge makes it: their
 * handle, lower case, with anything but letters, digits, "-", "_" and "."
 * replaced (a handle has none; the app's commands refuse what is not a
 * handle). */
export const replicaFile = (handle: string) =>
  `replica-${handle.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}.sqlite`;

/** A driver whose database opens on first use; an open that failed is
 * tried again on the next call (review round 1 of phase 3, finding 7). */
function lazyDriver(open: () => Promise<SqliteDriver>): SqliteDriver {
  let db: Promise<SqliteDriver> | null = null;
  const get = () =>
    (db ??= open().catch((e: unknown) => {
      db = null;
      throw e;
    }));
  return {
    execute: async (sql, params) => (await get()).execute(sql, params),
    select: async <T>(sql: string, params?: unknown[]) => (await get()).select<T>(sql, params),
    batch: async (statements: readonly SqlStatement[]) => (await get()).batch(statements),
  };
}

/** Why the replica could not be opened: `LOCKED` when another copy of the
 * app holds its file, else what failed. */
export interface StorageProblem {
  handle: string;
  code: string;
  message: string;
}

export type DesktopState = "signin" | "app" | "storage";

export class Desktop implements Platform {
  readonly kind = "desktop" as const;
  readonly credentials: RequestCredentials = "omit";
  readonly persist = true;
  readonly here = "this Mac";
  private account: SignedIn | null;
  private readonly stores = new Map<string, SqliteStorage>();
  private readonly listeners = new Set<() => void>();
  private observer: MutationObserver | null = null;
  private problemValue: StorageProblem | null = null;

  private constructor(
    readonly bridge: DesktopBridge,
    readonly origin: string,
    account: SignedIn | null,
  ) {
    this.account = account;
  }

  /** The platform with the sign-in the Keychain holds (none when the item
   * is missing or not one of ours). */
  static async start(bridge: DesktopBridge): Promise<Desktop> {
    const origin = (await bridge.serverOrigin()).replace(/\/+$/, "");
    let account: SignedIn | null = null;
    try {
      const raw = await bridge.keychainGet();
      const v: unknown = raw ? JSON.parse(raw) : null;
      if (isSignedIn(v)) account = v;
    } catch {
      account = null;
    }
    return new Desktop(bridge, origin, account);
  }

  // ---- what the shell shows ----

  state(): DesktopState {
    if (!this.account) return "signin";
    return this.problemValue ? "storage" : "app";
  }
  handle(): string | null {
    return this.account?.handle ?? null;
  }
  /** Why the replica could not be opened (state "storage"). */
  problem(): StorageProblem | null {
    return this.problemValue;
  }
  onChange(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  private changed() {
    for (const l of [...this.listeners]) l();
  }

  /** The browser approved the sign-in and the app took its token
   * (`devices.token`): it is kept in the Keychain. Rejects when the
   * Keychain does not take it; the app is then still signed out. */
  async signedIn(t: { token: string; device: string; u: string }): Promise<void> {
    const account: SignedIn = { token: t.token, device: t.device, handle: t.u, me: null };
    await this.bridge.keychainSet(JSON.stringify(account));
    this.account = account;
    this.problemValue = null;
    this.changed();
  }

  /** The server revokes a device's token (best effort: a server out of
   * reach keeps it until it expires). */
  async revoke(t: { token: string; device: string }): Promise<void> {
    await fetch(`${this.origin}/api/rpc/devices.revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ id: t.device }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }

  /** The window's title follows the page's. */
  followTitle(doc: Document = document): void {
    const set = () => this.bridge.setTitle(doc.title || "Session");
    set();
    const head = doc.querySelector("head");
    if (!head || typeof MutationObserver === "undefined") return;
    this.observer?.disconnect();
    this.observer = new MutationObserver(set);
    this.observer.observe(head, { subtree: true, childList: true, characterData: true });
  }

  // ---- Platform ----

  headers(): Record<string, string> {
    return {};
  }
  token(): string | null {
    return this.account?.token ?? null;
  }
  storage(user: string): SqliteStorage {
    let s = this.stores.get(user);
    if (!s) {
      s = new SqliteStorage(lazyDriver(() => this.bridge.openReplica(user)));
      this.stores.set(user, s);
    }
    return s;
  }
  lastMe(): unknown {
    return this.account?.me ?? null;
  }
  /** Kept only for the sign-in that read it, and only the account of the
   * sign-in's person. */
  rememberMe(me: unknown, token: string | null): void {
    const a = this.account;
    if (!a || token !== a.token || me === null || typeof me !== "object") return;
    const handle = (me as { handle?: unknown }).handle ?? (me as { u?: unknown }).u;
    if (handle !== a.handle) return;
    if (JSON.stringify(me) === JSON.stringify(a.me)) return;
    a.me = me;
    void this.bridge.keychainSet(JSON.stringify(a)).catch(() => undefined);
  }
  openExternal(url: string): Promise<void> {
    return this.bridge.openUrl(/^(https?|mailto):/.test(url) ? url : `${this.origin}${url}`);
  }
  /** Sign out: the server revokes this device's token (when it can be
   * reached), and the device forgets the token and the replica. */
  async signOut(): Promise<void> {
    const a = this.account;
    if (a) await this.revoke(a);
    await this.forget();
  }
  /** The server no longer takes `token`: when it is this sign-in's, the
   * sign-in and the replica go. */
  unauthorized(token: string | null): void {
    if (this.account && token === this.account.token) void this.forget();
  }
  /** The replica of the person signed in could not be opened: the storage
   * problem shows (and the client's screens close). */
  storageFailed(user: string, error: unknown): void {
    if (this.account?.handle !== user) return;
    const e = replicaError(error);
    // the storage that failed is made again by Try again
    this.stores.delete(user);
    this.problemValue = { handle: user, code: e.code, message: e.message };
    this.changed();
  }
  /** Update Session: the app has no updater yet (phase 5), so the download
   * page opens in the browser. */
  update(): void {
    void this.openExternal("/download").catch(() => undefined);
  }

  // ---- the storage problem ----

  /** Try again: the client's screens open the replica again. */
  retryStorage(): void {
    if (!this.problemValue) return;
    this.problemValue = null;
    this.changed();
  }

  /** The writes in the outbox of the replica that could not be opened, as
   * far as its file can be read; null when it cannot be (another copy of
   * the app holds it, or SQLite fails). */
  async unsentWrites(): Promise<OutboxEntry[] | null> {
    const p = this.problemValue;
    if (!p) return null;
    try {
      const db = await this.bridge.openReplica(p.handle);
      const rows = await db.select<{ body: string }>(
        "SELECT body FROM sync_client_outbox ORDER BY pos",
      );
      return rows.flatMap((r) => {
        try {
          const e = JSON.parse(r.body) as Partial<OutboxEntry> | null;
          return e &&
            typeof e.name === "string" &&
            typeof e.local === "string" &&
            e.state !== "answered"
            ? [e as OutboxEntry]
            : [];
        } catch {
          return [];
        }
      });
    } catch {
      return null;
    }
  }

  /** Reset: the replica's file (and the writes in it) is deleted, and the
   * client's screens read the person's spaces again from the server. Not
   * while another copy of the app holds the file. */
  async resetReplica(): Promise<void> {
    const p = this.problemValue;
    if (!p || p.code === "LOCKED") return;
    await this.dropReplica(p.handle);
    this.problemValue = null;
    this.changed();
  }

  /** The person's replica closes and its file is deleted; when the file
   * cannot be deleted, its rows are. */
  private async dropReplica(handle: string): Promise<void> {
    const s = this.stores.get(handle);
    this.stores.delete(handle);
    await s?.close().catch(() => undefined);
    try {
      await this.bridge.deleteReplica(handle);
    } catch {
      await this.bridge
        .openReplica(handle)
        .then((d) => new SqliteStorage(d).clear())
        .catch(() => undefined);
    }
  }

  /** The sign-in shows, and the replica, the outbox and the Keychain item
   * go. The storage is closed first, so nothing a late answer of the
   * session brings is stored, and the Keychain item is deleted; then the
   * screens (and the session) are taken down, and the file is deleted
   * (review round 1 of phase 3, findings 1 and 5). */
  private async forget(): Promise<void> {
    const a = this.account;
    const s = a ? this.stores.get(a.handle) : undefined;
    const closing = s?.close().catch(() => undefined);
    this.account = null;
    this.problemValue = null;
    await this.bridge.keychainDelete().catch(() => undefined);
    this.changed();
    await closing;
    await new Promise((r) => setTimeout(r, 0));
    if (a) await this.dropReplica(a.handle);
  }
}
