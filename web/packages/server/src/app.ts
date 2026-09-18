// The Hono application, assembled from its dependencies so a test can build a
// whole server over a temp database and drive it with `app.request()`
// (ADR-2, `12-testing-linting-ci.md` §3.4).

import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { trpcServer } from "@hono/trpc-server";
import { version } from "@session/shared";
import type { Context } from "hono";
import { Hono } from "hono";

import { artifactRoutes } from "./artifacts/route.js";
import type { OAuthClient } from "./auth/github.js";
import { githubRoutes } from "./auth/github.js";
import { clearSessionCookie, sessionLoader } from "./auth/session.js";
import type { AppEnv, ServerDeps } from "./deps.js";
import type { Readiness } from "./health.js";
import { createReadiness } from "./health.js";
import { defaultLogger } from "./logger.js";
import { MetricsRegistry, renderMetrics } from "./metrics.js";
import { csrfGuard } from "./middleware/csrf.js";
import { requestLogging } from "./middleware/logging.js";
import { requestMetrics } from "./middleware/metrics.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestId.js";
import { securityHeaders } from "./middleware/security.js";
import { clientStatic } from "./middleware/static.js";
import type { AppContext } from "./trpc/base.js";
import { createAppContext } from "./trpc/base.js";
import { appRouter } from "./trpc/router.js";
import { uploadRoutes } from "./uploads/route.js";

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
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const {
    limiter = new RateLimiter(),
    readiness = createReadiness("ready"),
    metrics = new MetricsRegistry(),
    createOAuthClient,
    clientDistDirectory,
    ...deps
  } = options;
  const logger = deps.logger ?? defaultLogger(deps.config.env);
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(logger));
  app.use("*", requestMetrics(metrics));
  app.use("*", requestLogging());
  app.use("*", securityHeaders(deps.config));

  // The artifact origin is a different host with its own headers and no
  // session; it is mounted before the CSRF guard and the session loader so a
  // token URL never carries either.
  app.route("/", artifactRoutes(deps));

  app.use("*", csrfGuard(deps.config));
  app.use("*", sessionLoader(deps));

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
  app.route("/", uploadRoutes({ deps: { ...deps, logger }, limiter }));

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
