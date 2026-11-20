// `@session/sync`'s server half on the server's own database connection
// (phase 2a): one database file, one writer. The store is the package's
// SQLite store over the same better-sqlite3 handle drizzle uses, so a sync
// transaction and the repositories' statements share one connection, and
// the API key vault writes `api_keys` inside the call's sync transaction.

import { apiKeys, users, type KeyCipher, type SessionDatabase } from "@session/db";
import type { Registry } from "@session/mutators";
import {
  SqliteServerStore,
  SyncServer,
  keyMask,
  keyProvider,
  type Clock,
  type JobRunner,
  type KeyVault,
  type OnlineHandlers,
  type StoreTx,
  type SyncServerOptions,
} from "@session/sync/server";

import { canUseModel } from "@session/shared";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

/** The raw values of API keys in `api_keys`, encrypted with the configured
 * key. The sync store holds the `apikey` record; both are written in the
 * same transaction (the store's, on the same connection). */
export class DbKeyVault implements KeyVault {
  constructor(
    private readonly db: SessionDatabase,
    private readonly cipher: KeyCipher,
  ) {}

  private userId(u: string): string {
    const user = users.findByHandle(this.db, u);
    if (!user) throw new Error(`no account has the handle ${u}`);
    return user.id;
  }

  find(_tx: StoreTx, u: string, raw: string): string | null {
    const user = users.findByHandle(this.db, u);
    return user ? apiKeys.findByRaw(this.db, this.cipher, user.id, u, raw) : null;
  }

  put(_tx: StoreTx, u: string, id: string, raw: string, now: number): void {
    apiKeys.put(this.db, this.cipher, {
      id,
      userId: this.userId(u),
      handle: u,
      raw,
      mask: keyMask(raw),
      provider: keyProvider(raw),
      at: now,
    });
  }

  delete(_tx: StoreTx, _u: string, id: string): void {
    apiKeys.remove(this.db, id);
  }
}

export interface CreateSyncOptions {
  db: SessionDatabase;
  config: Config;
  keys: KeyCipher;
  logger: Logger;
  jobs?: JobRunner;
  /** Handlers for the online calls the package leaves to the server
   * (settings, usage). */
  online?: Partial<OnlineHandlers>;
  /** Test only: the suite's clock, random source, mutators and failures. */
  clock?: Clock;
  random?: () => number;
  registry?: Registry;
  failEffect?: SyncServerOptions["failEffect"];
}

export function createSync(o: CreateSyncOptions): SyncServer {
  const prev = o.config.sync.previousCursorKey;
  return new SyncServer({
    // `openDatabase` applied the package's migrations
    store: new SqliteServerStore(o.db.$client, { migrations: false }),
    clock: o.clock ?? { now: () => Date.now() },
    cursorKeys: {
      current: o.config.sync.cursorKey,
      ...(prev ? { previous: prev } : {}),
    },
    keys: new DbKeyVault(o.db, o.keys),
    minProtocol: o.config.sync.minProtocol,
    queuedRunsPerUser: o.config.limits.queuedPerUser,
    // an admin-only model runs on the included tokens for an admin only
    includedModel: (u, model) => canUseModel(users.findByHandle(o.db, u), model),
    // a housekeeping fault is counted by the server (`housekeepingFaults`,
    // on `/metrics`) and logged here
    onError: (error, where) => o.logger.error({ err: error, where }, "sync housekeeping failed"),
    ...(o.jobs ? { jobs: o.jobs } : {}),
    ...(o.online ? { online: o.online } : {}),
    ...(o.random ? { random: o.random } : {}),
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.failEffect ? { failEffect: o.failEffect } : {}),
  });
}
