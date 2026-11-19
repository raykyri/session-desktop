// A whole server over a temp-file database: the app for `app.request()` and a
// tRPC caller for the account procedures (`12-testing-linting-ci.md` §3.4),
// with the real sync server and the real job runner (fixture providers, no
// timers: a test drives `work` and `tick`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDatabase } from "@session/db";
import { auth, closeDatabase, openDatabase, users } from "@session/db";
import type { User } from "@session/shared";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@session/sync";
import type { ExecutionContext } from "ava";
import type { Hono } from "hono";

import { createApp } from "../src/app.js";
import type { OAuthClient } from "../src/auth/github.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { AppEnv, ServerDeps } from "../src/deps.js";
import type { Logger } from "../src/logger.js";
import { createLogger } from "../src/logger.js";
import { buildDeps } from "../src/main.js";
import { RateLimiter } from "../src/middleware/rateLimit.js";
import type { RunsServiceDeps } from "../src/runs/service.js";
import { createAppContext } from "../src/trpc/base.js";
import { appRouter, createCallerFactory } from "../src/trpc/router.js";

export const PUBLIC_ORIGIN = "http://localhost:8787";
export const DESKTOP_ORIGIN = "tauri://localhost";

const callerFactory = createCallerFactory(appRouter);

export type Caller = ReturnType<typeof callerFactory>;

export interface Harness {
  config: Config;
  db: SessionDatabase;
  deps: ServerDeps;
  logger: Logger;
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
  /** A JSON POST with the SPA's headers and the protocol header. */
  post(path: string, body: unknown, cookie?: string, headers?: Record<string, string>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  createOAuthClient?: (deps: ServerDeps) => OAuthClient;
  runs?: Partial<RunsServiceDeps>;
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
    SESSION_FIXTURE_PROVIDERS: "1",
    // Every provider has a credential, so no model is hidden as unavailable.
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    GOOGLE_VERTEX_PROJECT: "session-test",
    OPENROUTER_API_KEY: "openrouter-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    PARALLEL_API_KEY: "parallel-key",
    SESSION_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
    SESSION_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    ...overrides,
  });
}

export function createHarness(t: ExecutionContext, options: HarnessOptions = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "session-server-"));
  const config = testConfig(directory, options.env);
  const db = openDatabase(config.databasePath);
  const logger = createLogger({ level: "error", write: () => undefined });
  const deps = buildDeps({
    config,
    db,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    runs: { autoStart: false, ...options.runs },
  });
  t.teardown(async () => {
    await deps.runs.drain();
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  const limiter = new RateLimiter();
  const app = createApp({
    ...deps,
    limiter,
    // No client bundle in a test checkout; the SPA fallback stays off.
    clientDistDirectory: join(directory, "no-client"),
    ...(options.createOAuthClient ? { createOAuthClient: options.createOAuthClient } : {}),
  });
  const request: Harness["request"] = async (path, init = {}) => {
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
  };
  return {
    config,
    db,
    deps,
    logger,
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
    request,
    post: async (path, body, cookie, headers = {}) => {
      const res = await request(path, {
        method: "POST",
        body: JSON.stringify(body),
        ...(cookie ? { cookie } : {}),
        headers: {
          "Content-Type": "application/json",
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          ...headers,
        },
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
  };
}
