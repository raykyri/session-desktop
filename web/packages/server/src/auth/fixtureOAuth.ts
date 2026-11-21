// Fixture OAuth providers for the end-to-end suite (`SESSION_FIXTURE_OAUTH=1`,
// never in production; `config.ts` refuses it there).
//
// The browser goes through the real handshake: `POST /auth/<p>/start`
// answers an authorization URL on this server, `GET
// /auth/fixture/<p>/authorize` stands in for the provider's consent page and
// redirects to the real callback with a code, and the callback exchanges the
// code and reads the profile through `fixtureOAuthFetch`, which answers the
// fixture token and profile endpoints in process.
//
// The identity is the `session_fixture_identity` cookie a spec sets before
// it clicks a sign-in button: `<login>` becomes the provider username, a
// stable user id derived from provider and login, and the name
// `Fixture <login>`.

import { createHash } from "node:crypto";

import type { SignInProvider } from "@session/shared";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

import { isProvider } from "./providers.js";

export const FIXTURE_IDENTITY_COOKIE = "session_fixture_identity";

const CODE_PREFIX = "fixture-code.";
const TOKEN_PREFIX = "fixture-token.";

function fixtureUserId(provider: SignInProvider, login: string): string {
  const digest = createHash("sha256").update(`${provider}:${login}`).digest();
  return provider === "github"
    ? String(digest.readUInt32BE(0))
    : // X ids are decimal strings of 64-bit numbers.
      digest.readBigUInt64BE(0).toString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loginOf(token: string | null | undefined, prefix: string): string | null {
  return token?.startsWith(prefix) ? decodeURIComponent(token.slice(prefix.length)) : null;
}

/** Answers the fixture token and profile endpoints of `providers.ts`
 * (`fixtureEndpoints`) in process; any other URL is a 404. */
export function fixtureOAuthFetch(config: Config): typeof globalThis.fetch {
  const base = `${config.publicOrigin}/auth/fixture/`;
  const answer = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Response => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!url.href.startsWith(base)) return json({ error: "not_found" }, 404);
    const [provider, ...rest] = url.pathname.slice("/auth/fixture/".length).split("/");
    if (!isProvider(provider)) return json({ error: "not_found" }, 404);
    const path = rest.join("/");
    if (path === "token" && init?.method === "POST") {
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      const login = loginOf(body.get("code"), CODE_PREFIX);
      if (login === null || !body.get("code_verifier")) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ access_token: `${TOKEN_PREFIX}${encodeURIComponent(login)}` });
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const login = loginOf(authorization.replace(/^Bearer /u, ""), TOKEN_PREFIX);
    if (login === null) return json({ error: "unauthorized" }, 401);
    const id = fixtureUserId(provider, login);
    if (provider === "github" && path === "user") {
      return json({
        id: Number(id),
        login,
        name: `Fixture ${login}`,
        avatar_url: null,
        created_at: "2020-01-01T00:00:00Z",
      });
    }
    if (provider === "github" && path === "user/emails") {
      return json([{ email: `${login}@example.test`, primary: true, verified: true }]);
    }
    if (provider === "x" && path === "users/me") {
      return json({
        data: {
          id,
          username: login,
          name: `Fixture ${login}`,
          created_at: "2020-01-01T00:00:00.000Z",
          confirmed_email: `${login}@example.test`,
        },
      });
    }
    return json({ error: "not_found" }, 404);
  };
  return (input, init) => Promise.resolve(answer(input, init));
}

/** The consent page: redirects to the callback with a code for the identity
 * in the cookie, or with `error=access_denied` when there is none. */
export function fixtureOAuthRoutes(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/auth/fixture/:provider/authorize", (c) => {
    const redirect = URL.parse(c.req.query("redirect_uri") ?? "");
    const state = c.req.query("state") ?? "";
    // Only this server's own callbacks: the page is not an open redirect.
    if (
      !redirect ||
      redirect.origin !== config.publicOrigin ||
      !isProvider(c.req.param("provider"))
    ) {
      return c.text("bad request\n", 400);
    }
    const login = getCookie(c, FIXTURE_IDENTITY_COOKIE);
    if (login) {
      redirect.searchParams.set("code", `${CODE_PREFIX}${encodeURIComponent(login)}`);
    } else {
      redirect.searchParams.set("error", "access_denied");
    }
    redirect.searchParams.set("state", state);
    return c.redirect(redirect.href, 302);
  });
  return app;
}
