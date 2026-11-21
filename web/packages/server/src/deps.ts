// What the Hono app and the tRPC router are built from. `app.ts` takes these
// rather than reaching for module-level singletons so a test can construct a
// whole server over a temp-file database (`12-testing-linting-ci.md` §3.4).

import type { SessionDatabase } from "@session/db";
import type { User } from "@session/shared";

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { RunsService } from "./runs/service.js";

export interface ServerDeps {
  config: Config;
  db: SessionDatabase;
  /** Attempts in progress, for the drain (`runs/service.ts`). */
  runs: RunsService;
  logger?: Logger;
  /** Outbound HTTP (GitHub, the run tools). Injected so tests can
   * answer without a network. */
  fetch?: typeof globalThis.fetch;
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
