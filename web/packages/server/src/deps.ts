// What the Hono app and the tRPC router are built from. `app.ts` takes these
// rather than reaching for module-level singletons so a test can construct a
// whole server over a temp-file database (`12-testing-linting-ci.md` §3.4).

import type { SessionDatabase } from "@session/db";
import type { ModelEntry, User } from "@session/shared";

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Ledger } from "./runs/ledger.js";
import type { RunTexts } from "./runs/runTexts.js";
import type { RunsService } from "./runs/service.js";
import type { SpaceDirectory } from "./spaces/directory.js";

export interface ServerDeps {
  config: Config;
  db: SessionDatabase;
  /** Attempts in progress, for the drain (`runs/service.ts`). */
  runs: RunsService;
  logger?: Logger;
  /** Outbound HTTP (GitHub, the run tools, the API key check). Injected so
   * tests can answer without a network. */
  fetch?: typeof globalThis.fetch;
  /** The usage ledger `usage.get` and `usage.listRuns` read (`03` K1, K5).
   * An empty in-memory ledger when absent, until the SQLite ledger lands. */
  ledger?: Ledger;
  /** The question of a run as its asker may read it now (`03` K5). Every
   * run reads as unavailable when absent, until the run records land. */
  runTexts?: RunTexts;
  /** The model registry; `MODEL_REGISTRY` when absent. Tests pass another to
   * cover entries the registry does not have (a key-only model). */
  models?: readonly ModelEntry[];
  /** How long `apiKeys.set` waits for the provider; 10 s when absent. */
  keyCheckTimeoutMs?: number;
  /** The clock of the usage week; `Date.now` when absent. */
  now?: () => number;
  /** Where `spaces.directory` reads the open channels; none when absent. */
  directory?: SpaceDirectory;
}

/** Per-request state the middlewares publish and the handlers read. */
export interface RequestVariables {
  requestId: string;
  logger: Logger;
  user: User | null;
  sessionToken: string | null;
  clientIp: string;
  /** The hashed per-IP limit key (`hashClientIp`): IPv6 by /64 prefix. */
  ipKey: string;
}

export interface AppEnv {
  Variables: RequestVariables;
}
