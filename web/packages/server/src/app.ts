// The Hono application, assembled from its dependencies so a test can build a
// whole server over a temp database and drive it with `app.request()`
// (ADR-2, `12-testing-linting-ci.md` §3.4).

import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { trpcServer } from "@hono/trpc-server";
import { version } from "@session/shared";
import type { Context } from "hono";
import { Hono } from "hono";

import { authRoutes } from "./auth/routes.js";
import { clearSessionCookie, clientKey, sessionLoader } from "./auth/session.js";
import type { AppEnv, ServerDeps } from "./deps.js";
import type { Readiness } from "./health.js";
import { createReadiness } from "./health.js";
import { defaultLogger } from "./logger.js";
import { MetricsRegistry, renderMetrics } from "./metrics.js";
import { csrfGuard, rejectAuthorizationHeader } from "./middleware/csrf.js";
import { requestLogging } from "./middleware/logging.js";
import { requestMetrics } from "./middleware/metrics.js";
import { RateLimiter, preLimits } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestId.js";
import { securityHeaders } from "./middleware/security.js";
import { clientStatic } from "./middleware/static.js";
import { storeDirectory } from "./sync/directory.js";
import { protocolCheck } from "./sync/protocol.js";
import { syncRoutes } from "./sync/routes.js";
import { SyncService } from "./sync/service.js";
import { syncTestRoutes } from "./sync/testRoutes.js";
import { createAppContext } from "./trpc/base.js";
import type { AppContext } from "./trpc/base.js";
import { appRouter } from "./trpc/router.js";

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
  clientDistDirectory?: string;
  /** The work budget of one `POST /api/sync/read` (`sync/routes.ts`). */
  readBudget?: { bytes: number; ms: number };
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const {
    limiter = new RateLimiter(),
    readiness = createReadiness("ready"),
    metrics = new MetricsRegistry(),
    clientDistDirectory,
    readBudget,
    ...deps
  } = options;
  const logger = deps.logger ?? defaultLogger(deps.config.env);
  const sync = deps.sync ?? new SyncService({ db: deps.db, config: deps.config, logger });
  deps.sync = sync;
  // `04` Z1: the mutators' `pre`-stage limits count in this app's buckets
  sync.server.setPreLimits(preLimits(limiter, deps.config.abuse));
  deps.directory ??= storeDirectory(sync.store);
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(logger));
  app.use("*", clientKey(deps.config));
  app.use("*", requestMetrics(metrics));
  app.use("*", requestLogging());
  app.use("*", securityHeaders(deps.config));

  app.use("*", rejectAuthorizationHeader());
  app.use("*", csrfGuard(deps.config));
  // `01` S1: the protocol version before authentication, on the sync routes,
  // the run reads and tRPC.
  for (const path of ["/api/sync/*", "/api/runs/*", "/api/trpc/*"])
    app.use(path, protocolCheck(deps.config));
  app.use("*", sessionLoader(deps));

  // The sync routes take the limits of `04` Z1 themselves, after the route
  // matched (`sync/routes.ts`).
  // The acceptance suite's test access (`01` A1): only with
  // `SESSION_TEST_ROUTES=1`, which the configuration accepts only in a test
  // server on a loopback origin (`config.ts`).
  if (deps.config.testRoutes) app.route("/api/sync/test", syncTestRoutes(sync));
  app.route(
    "/api/sync",
    syncRoutes({ sync, config: deps.config, limiter, ...(readBudget ? { readBudget } : {}) }),
  );

  // `03` T3: a client that saw a gap in a run's deltas, or reconnected, reads
  // the attempt's committed turns and the turn still streaming. The read
  // scope is `pull`'s: a reader who may not read the run's text gets
  // NOT_FOUND, as for a run that does not exist.
  app.get("/api/runs/:id/live", (c) => {
    const user = c.get("user");
    const reader = user?.status === "active" ? user.handle : null;
    const live = deps.runLive?.(c.req.param("id"), reader) ?? null;
    c.header("Cache-Control", "no-store");
    if (live === null)
      return c.json({ code: "NOT_FOUND", message: "Not found.", serverTime: Date.now() }, 404);
    return c.json(live, 200);
  });

  // Fly's check. 503 until migrations and run reconciliation are done and
  // again from the first moment of the drain, so the proxy never routes to a
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
    // `?gc=1` collects garbage first, so the heap gauge is what is live: only
    // in a process started with `--expose-gc` (the load check's), never in
    // the production image, which does not pass it
    const gc = (globalThis as { gc?: () => void }).gc;
    if (c.req.query("gc") === "1" && typeof gc === "function") gc();
    return c.text(
      renderMetrics({
        deps,
        config: deps.config,
        registry: metrics,
        health: readiness.state(),
        limiter,
      }),
      200,
      { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
    );
  });

  app.route("/", authRoutes({ deps: { ...deps, logger }, limiter }));

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
        // The adapter hands over an untyped context; the variables were set by
        // `requestContext` and `sessionLoader` above.
        const c = honoContext as Context<AppEnv>;
        return createAppContext({ ...deps, logger }, limiter, c.get("logger"), {
          user: c.get("user"),
          clientIp: c.get("clientIp"),
          ipKey: c.get("ipKey"),
          sessionToken: c.get("sessionToken"),
        }) as unknown as Record<string, unknown>;
      },
      // Every failure the error table did not deliberately classify is logged
      // at error level with the request id, through the per-request child
      // logger the context carries: an unclassified error is by definition one
      // nobody predicted, and `c.get("logger")` is what ties it to the request
      // it broke. `logger` alone is the fallback for a failure thrown before
      // the context existed.
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
