// A whole server over a temp-file database: the app for `app.request()` and a
// tRPC caller for the procedure tests (`12-testing-linting-ci.md` §3.4).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDatabase } from "@session/db";
import { auth, closeDatabase, openDatabase, users } from "@session/db";
import type { User } from "@session/shared";
import type { ExecutionContext } from "ava";
import type { Hono } from "hono";

import { createApp } from "../src/app.js";
import { testHandle } from "../src/auth/routes.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { AppEnv, ServerDeps } from "../src/deps.js";
import type { Logger } from "../src/logger.js";
import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/middleware/rateLimit.js";
import type { NoopRunsService, RunsService } from "../src/runs/service.js";
import { createNoopRunsService } from "../src/runs/service.js";
import { createAppContext } from "../src/trpc/base.js";
import { appRouter, createCallerFactory } from "../src/trpc/router.js";

export const PUBLIC_ORIGIN = "http://localhost:8787";

const callerFactory = createCallerFactory(appRouter);

export type Caller = ReturnType<typeof callerFactory>;

export interface Harness {
  config: Config;
  db: SessionDatabase;
  deps: ServerDeps;
  logger: Logger;
  /** Every line the server logged, at every level. */
  logs: string[];
  /** The recording stand-in, unless `createRuns` replaced it. */
  runs: NoopRunsService;
  limiter: RateLimiter;
  app: Hono<AppEnv>;
  directory: string;
  /** A caller bound to `user`, or anonymous when it is null. */
  caller(user: User | null): Caller;
  /** Creates an account directly, the way the database tests do. */
  addUser(login: string, options?: { isAdmin?: boolean; invitedBy?: string | null }): User;
  /** A waiting account for a new identity. */
  addWaitingUser(login: string, options?: { pendingInviteId?: string | null }): User;
  /** A session cookie for `user`. */
  signIn(user: User): string;
  /** `app.request()` with the headers the SPA sends. */
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Swaps the recording stand-in for another runs service. */
  createRuns?: (deps: Omit<ServerDeps, "runs">) => RunsService;
  /** The rate limiter's clock; a test of a budget pins it so the bucket does
   * not refill while the test runs. */
  limiterNow?: () => number;
  /** The ledger, run texts, registry, key check timeout and clock the
   * procedures read (`deps.ts`). */
  deps?: Pick<ServerDeps, "ledger" | "runTexts" | "models" | "keyCheckTimeoutMs" | "now">;
}

let githubIdCounter = 5000;

export function testConfig(directory: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8787",
    SESSION_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    SESSION_DATA_DIR: directory,
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_TEST_AUTH: "1",
    // Every provider has a credential, so no model is hidden as unavailable.
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    GOOGLE_VERTEX_PROJECT: "session-test",
    OPENROUTER_API_KEY: "openrouter-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    PARALLEL_API_KEY: "parallel-key",
    ...overrides,
  });
}

export function createHarness(t: ExecutionContext, options: HarnessOptions = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "session-server-"));
  const config = testConfig(directory, options.env);
  const db = openDatabase(config.databasePath);
  t.teardown(() => {
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  // Every line is kept, so a test can assert what was and was not logged.
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => logs.push(line) });
  const runs = createNoopRunsService();
  const limiter = new RateLimiter(options.limiterNow);
  const base = {
    config,
    db,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...options.deps,
  };
  const deps: ServerDeps = { ...base, runs: options.createRuns?.(base) ?? runs };
  const app = createApp({
    ...deps,
    limiter,
    // No client bundle in a test checkout; the SPA fallback stays off.
    clientDistDirectory: join(directory, "no-client"),
  });
  return {
    config,
    db,
    deps,
    logger,
    logs,
    runs,
    limiter,
    app,
    directory,
    caller: (user) =>
      callerFactory(createAppContext(deps, limiter, logger, { user, clientIp: "127.0.0.1" })),
    addUser: (login, addOptions = {}) => {
      githubIdCounter += 1;
      const handle = testHandle(login.length < 3 ? `${login}___` : login);
      const user = users.createActive(
        db,
        { provider: "github", providerUserId: String(githubIdCounter), login, name: login },
        { handle, displayName: login, invitedBy: addOptions.invitedBy ?? null },
      );
      return addOptions.isAdmin === true ? users.setAdminByHandle(db, handle, true) : user;
    },
    addWaitingUser: (login, addOptions = {}) => {
      githubIdCounter += 1;
      return users.createWaiting(
        db,
        { provider: "x", providerUserId: `x-${githubIdCounter}`, login, name: login },
        { pendingInviteId: addOptions.pendingInviteId ?? null },
      ).user;
    },
    signIn: (user) => auth.createSession(db, user.id).token,
    request: async (path, init = {}) => {
      const { cookie, headers, ...rest } = init;
      return app.request(path, {
        ...rest,
        headers: {
          Origin: PUBLIC_ORIGIN,
          "X-Requested-With": "session",
          ...(cookie ? { Cookie: `session=${cookie}` } : {}),
          ...(headers as Record<string, string> | undefined),
        },
      });
    },
  };
}
