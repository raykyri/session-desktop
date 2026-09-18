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
import type { OAuthClient } from "../src/auth/github.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { AppEnv, ServerDeps } from "../src/deps.js";
import { EventBus } from "../src/events/bus.js";
import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/middleware/rateLimit.js";
import type { NoopRunsService } from "../src/runs/service.js";
import { createNoopRunsService } from "../src/runs/service.js";
import { createAppContext } from "../src/trpc/base.js";
import { appRouter, createCallerFactory } from "../src/trpc/router.js";

export const PUBLIC_ORIGIN = "http://localhost:8787";
export const ARTIFACT_ORIGIN = "http://artifacts.localhost:8787";

const callerFactory = createCallerFactory(appRouter);

export type Caller = ReturnType<typeof callerFactory>;

export interface Harness {
  config: Config;
  db: SessionDatabase;
  deps: ServerDeps;
  eventBus: EventBus;
  runs: NoopRunsService;
  limiter: RateLimiter;
  app: Hono<AppEnv>;
  directory: string;
  /** A caller bound to `user`, or anonymous when it is null. */
  caller(user: User | null): Caller;
  /** Creates an account directly, the way the database tests do. */
  addUser(login: string, options?: { isAdmin?: boolean }): User;
  /** A session cookie for `user`. */
  signIn(user: User): string;
  /** `app.request()` with the headers the SPA sends. */
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  createOAuthClient?: (deps: ServerDeps) => OAuthClient;
}

let githubIdCounter = 5000;

export function testConfig(directory: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8787",
    SESSION_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    SESSION_ARTIFACT_ORIGIN: ARTIFACT_ORIGIN,
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
  const logger = createLogger({ level: "error", write: () => undefined });
  const eventBus = new EventBus();
  const runs = createNoopRunsService();
  const limiter = new RateLimiter();
  const deps: ServerDeps = {
    config,
    db,
    eventBus,
    runs,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const app = createApp({
    ...deps,
    limiter,
    // No client bundle in a test checkout; the SPA fallback stays off.
    clientDistDirectory: join(directory, "no-client"),
    ...(options.createOAuthClient ? { createOAuthClient: options.createOAuthClient } : {}),
  });
  return {
    config,
    db,
    deps,
    eventBus,
    runs,
    limiter,
    app,
    directory,
    caller: (user) =>
      callerFactory(createAppContext(deps, limiter, logger, { user, clientIp: "127.0.0.1" })),
    addUser: (login, addOptions = {}) => {
      githubIdCounter += 1;
      const { user } = users.upsertFromGitHub(db, {
        githubId: githubIdCounter,
        login,
        name: login,
      });
      return addOptions.isAdmin === true ? users.setAdmin(db, login, true) : user;
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

/** A highlight anchor over `exact` in the answer at `revision`. */
export function anchorFor(revision: string, exact: string, start = 0) {
  return {
    version: 1 as const,
    projection: "answer-v1" as const,
    responseRevision: revision,
    start,
    end: start + exact.length,
    exact,
    prefix: "",
    suffix: "",
  };
}

/** A minimal assistant turn, the shape a snapshot commit requires. */
export function answerTurn(nodeId: string, text: string, id = `${nodeId}-turn`) {
  return {
    id,
    agentId: nodeId,
    role: "assistant" as const,
    blocks: [{ type: "text" as const, text }],
    sourceIndex: 0,
  };
}
