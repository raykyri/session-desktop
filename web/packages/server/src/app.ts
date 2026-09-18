// The Hono application, assembled from its dependencies so a test can build a
// whole server over a temp database and drive it with `app.request()`
// (ADR-2, `12-testing-linting-ci.md` §3.4).

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
import { defaultLogger } from "./logger.js";
import { csrfGuard } from "./middleware/csrf.js";
import { requestLogging } from "./middleware/logging.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestId.js";
import { securityHeaders } from "./middleware/security.js";
import { clientStatic } from "./middleware/static.js";
import { createAppContext } from "./trpc/base.js";
import { appRouter } from "./trpc/router.js";
import { uploadRoutes } from "./uploads/route.js";

/** Where `npm run build --workspace @session/client` puts the bundle. */
const CLIENT_DIST = fileURLToPath(new URL("../../client/dist/app", import.meta.url));

export interface CreateAppOptions extends ServerDeps {
  limiter?: RateLimiter;
  /** Replaced by the auth tests, which have no GitHub to talk to. */
  createOAuthClient?: (deps: ServerDeps) => OAuthClient;
  clientDistDirectory?: string;
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { limiter = new RateLimiter(), createOAuthClient, clientDistDirectory, ...deps } = options;
  const logger = deps.logger ?? defaultLogger(deps.config.env);
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(logger));
  app.use("*", requestLogging());
  app.use("*", securityHeaders(deps.config));

  // The artifact origin is a different host with its own headers and no
  // session; it is mounted before the CSRF guard and the session loader so a
  // token URL never carries either.
  app.route("/", artifactRoutes(deps));

  app.use("*", csrfGuard(deps.config));
  app.use("*", sessionLoader(deps));

  app.get("/healthz", (c) =>
    c.text("ok\n", 200, { "Cache-Control": "no-store", "X-Session-Version": version }),
  );

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
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          logger.error({ error, path }, "trpc procedure failed");
        }
      },
    }),
  );

  const serveClient = clientStatic(clientDistDirectory ?? CLIENT_DIST);
  if (serveClient) {
    app.use("*", serveClient);
  }

  return app;
}
