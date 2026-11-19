// The Hono application, assembled from its dependencies so a test can build a
// whole server over a temp database and drive it with `app.request()`
// (ADR-2, `12-testing-linting-ci.md` §3.4).
//
// Middleware, in order: request id, metrics, logging, security headers, CORS
// for the desktop's bearer requests, the CSRF guard for cookie requests, and
// the session loader (a session cookie, or a device's bearer token: the
// actor the sync server takes). Routes: `/healthz`, `/metrics`, GitHub
// OAuth, uploads, the sync protocol and the account reads
// (`sync/routes.ts`), the account procedures over tRPC, and the client
// bundle.

import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { trpcServer } from "@hono/trpc-server";
import { version } from "@session/shared";
import type { Context } from "hono";
import { Hono } from "hono";

import type { OAuthClient } from "./auth/github.js";
import { githubRoutes } from "./auth/github.js";
import { clearSessionCookie, sessionLoader } from "./auth/session.js";
import type { AppEnv, ServerDeps } from "./deps.js";
import type { Readiness } from "./health.js";
import { createReadiness } from "./health.js";
import { defaultLogger } from "./logger.js";
import { MetricsRegistry, renderMetrics } from "./metrics.js";
import { desktopCors } from "./middleware/cors.js";
import { csrfGuard } from "./middleware/csrf.js";
import { requestLogging } from "./middleware/logging.js";
import { requestMetrics } from "./middleware/metrics.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestId.js";
import { securityHeaders } from "./middleware/security.js";
import { clientStatic } from "./middleware/static.js";
import { syncRoutes } from "./sync/routes.js";
import { scenarioRoutes } from "./sync/scenario.js";
import type { AppContext } from "./trpc/base.js";
import { createAppContext } from "./trpc/base.js";
import { appRouter } from "./trpc/router.js";
import { imageRoutes } from "./uploads/route.js";

/** Constant-time string comparison for the metrics bearer token. */
function timingSafeEqualString(offered: string, expected: string): boolean {
  const left = Buffer.from(offered, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Where `npm run build --workspace @session/client` puts the bundle. */
const CLIENT_DIST = fileURLToPath(new URL("../../client/dist/app", import.meta.url));

export interface CreateAppOptions extends ServerDeps {
  limiter?: RateLimiter;
  /** Boot and drain state behind `/healthz`. Defaults to ready, which is what
   * a test that builds the app directly wants (`13-deployment-fly.md` §5). */
  readiness?: Readiness;
  metrics?: MetricsRegistry;
  /** Replaced by the auth tests, which have no GitHub to talk to. */
  createOAuthClient?: (deps: ServerDeps) => OAuthClient;
  clientDistDirectory?: string;
  /** Test only: a directory served under `/mockups/` (the mockup on the real
   * server); mounted only with test sign-in on. */
  mockupsDirectory?: string;
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const {
    limiter = new RateLimiter(),
    readiness = createReadiness("ready"),
    metrics = new MetricsRegistry(),
    createOAuthClient,
    clientDistDirectory,
    mockupsDirectory,
    ...deps
  } = options;
  const logger = deps.logger ?? defaultLogger(deps.config.env);
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(logger));
  app.use("*", requestMetrics(metrics));
  app.use("*", requestLogging());
  app.use("*", securityHeaders(deps.config));
  app.use("*", desktopCors(deps.config));
  app.use("*", csrfGuard(deps.config));
  app.use("*", sessionLoader(deps));

  // Fly's check. 503 until migrations and run recovery are done and again
  // from the first moment of the drain, so the proxy never routes to a
  // process that cannot finish what it accepts (`13-deployment-fly.md` §5).
  app.get("/healthz", (c) => {
    const state = readiness.state();
    return c.text(state === "ready" ? "ok\n" : `${state}\n`, state === "ready" ? 200 : 503, {
      "Cache-Control": "no-store",
      "X-Session-Version": version,
    });
  });

  // Unset token = no endpoint at all, rather than an open one
  // (`web/.env.example`). Comparison is constant-time over tokens of equal
  // length; a token of the wrong length is rejected without comparing.
  app.get("/metrics", (c) => {
    const expected = deps.config.metricsToken;
    if (expected === null) {
      return c.notFound();
    }
    const offered = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!timingSafeEqualString(offered, expected)) {
      return c.text("unauthorized\n", 401, { "WWW-Authenticate": "Bearer" });
    }
    return c.text(
      renderMetrics({
        deps,
        config: deps.config,
        registry: metrics,
        health: readiness.state(),
      }),
      200,
      { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
    );
  });

  app.route(
    "/",
    githubRoutes({
      deps: { ...deps, logger },
      limiter,
      ...(createOAuthClient ? { createClient: createOAuthClient } : {}),
    }),
  );
  app.route("/", imageRoutes({ deps: { ...deps, logger }, limiter }));
  app.route("/", syncRoutes({ ...deps, logger }));
  // test only: a scenario's records into the store, and the mockup's files
  if (deps.config.testAuthEnabled)
    app.route("/", scenarioRoutes({ ...deps, logger }, mockupsDirectory));

  // `auth.logout` clears the session rows; the cookie is this layer's to
  // clear, so the mutation is mirrored here rather than given a `Set-Cookie`
  // from inside tRPC. Registered before the tRPC handler, which terminates.
  app.use("/api/trpc/auth.logout", async (c, next) => {
    await next();
    if (c.res.ok) {
      clearSessionCookie(c as Context<AppEnv>, deps.config);
    }
  });

  app.use(
    "/api/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/api/trpc",
      createContext: (_opts, honoContext) => {
        const c = honoContext as Context<AppEnv>;
        return createAppContext({ ...deps, logger }, limiter, c.get("logger"), {
          // a device token signs in to the sync API, not to the browser's
          // account procedures
          user: c.get("bearer") ? null : c.get("user"),
          clientIp: c.get("clientIp"),
          sessionToken: c.get("sessionToken"),
        }) as unknown as Record<string, unknown>;
      },
      onError: ({ error, path, type, ctx }) => {
        if (error.code !== "INTERNAL_SERVER_ERROR") {
          return;
        }
        const requestLogger = (ctx as AppContext | undefined)?.logger ?? logger;
        requestLogger.error(
          { err: error.cause ?? error, path, type, code: error.code },
          "trpc procedure failed",
        );
      },
    }),
  );

  const serveClient = clientStatic(clientDistDirectory ?? CLIENT_DIST);
  if (serveClient) {
    app.use("*", serveClient);
  }

  return app;
}
