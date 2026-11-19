// What the Hono app and the tRPC router are built from. `app.ts` takes these
// rather than reaching for module-level singletons so a test can construct a
// whole server over a temp-file database (`12-testing-linting-ci.md` §3.4).

import type { KeyCipher, SessionDatabase } from "@session/db";
import type { User } from "@session/shared";
import type { Actor } from "@session/sync";
import type { SyncServer } from "@session/sync/server";

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { RunsService } from "./runs/service.js";
import type { StreamRegistry } from "./sync/streams.js";

export interface ServerDeps {
  config: Config;
  db: SessionDatabase;
  /** `@session/sync`'s server half over the same database (phase 2a). */
  sync: SyncServer;
  /** The raw API keys' encryption (`api_keys.raw_enc`). */
  keys: KeyCipher;
  /** The open sync event streams, by session, so a sign-out closes them. */
  streams: StreamRegistry;
  runs: RunsService;
  logger?: Logger;
  /** Outbound HTTP (GitHub, key checks). Injected so tests can answer
   * without a network. */
  fetch?: typeof globalThis.fetch;
}

/** Per-request state the middlewares publish and the handlers read. */
export interface RequestVariables {
  requestId: string;
  logger: Logger;
  user: User | null;
  sessionToken: string | null;
  clientIp: string;
  /** Who the request is for, as the sync server takes it: the user's
   * handle, and the device when a device token authenticated it. */
  actor: Actor | null;
  /** True when `Authorization: Bearer` carried the credential (a device). */
  bearer: boolean;
}

export interface AppEnv {
  Variables: RequestVariables;
}
