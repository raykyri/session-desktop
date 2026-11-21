// Sign-in routes for GitHub and X (plan `04` I4, Z2; `06-auth-and-users.md`
// §2). Hono routes rather than tRPC procedures because the flow is browser
// redirects.
//
// - `POST /auth/<provider>/start` (JSON `{ code?, returnTo? }`, the CSRF
//   header, same origin) writes the `oauth_states` row with the provider and
//   the hash of the invite code, sets the state cookie and answers `{ url }`;
//   the client navigates there. The code never appears in a request line.
// - `GET /auth/<provider>` starts a sign-in without a code; an `invite`
//   parameter is ignored.
// - `GET /auth/<provider>/callback` finds the account by `(provider,
//   provider_user_id)`. An existing account signs in and the code is left
//   alone; the other provider's identity of the same person is a different
//   identity and takes the new-identity path. A new identity with an open
//   code becomes a waiting account holding that invite, which the profile
//   step redeems; without one it becomes a waiting account, at most 5 per IP
//   key a day.

import { timingSafeEqual } from "node:crypto";

import { accountInvites, auth, users } from "@session/db";
import type { SignInProvider } from "@session/shared";
import { isAccountHandle } from "@session/shared";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AppEnv, ServerDeps } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { abuseBuckets, rateLimitByIp } from "../middleware/rateLimit.js";
import { ZERO_COUNTS, weekOf } from "../runs/ledger.js";

import { fixtureOAuthFetch, fixtureOAuthRoutes } from "./fixtureOAuth.js";
import {
  ProviderError,
  authorizationUrl,
  credentialsFor,
  exchangeCode,
  fetchIdentity,
  isProvider,
  newHandshake,
  PROVIDER_LABELS,
} from "./providers.js";
import { clearSessionCookie, endSession, sessionCookieFrom, setSessionCookie } from "./session.js";

/** Checks for a backslash (normalized to a slash by Windows browsers) or a
 * control character, which could inject an additional header line. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || character === "\\") {
      return true;
    }
  }
  return false;
}

/**
 * Validates a same-origin redirect path after sign-in. Rejects absolute URLs,
 * protocol-relative URLs (`//host`), and paths containing backslashes or
 * control characters.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "" || value.length > 512) {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  if (hasUnsafeCharacter(value)) {
    return null;
  }
  return value;
}

/** Where a new identity without an open invite lands: the "Invite
 * required" page, which opens the "No Session account" step. */
export const NEW_WAITING_PATH = "/welcome?new=1";

/** The sign-in error page: `/login?error=<reason>`. */
function signInError(publicOrigin: string, reason: string): string {
  return `${publicOrigin}/login?error=${encodeURIComponent(reason)}`;
}

/**
 * The OAuth state also travels in a `SameSite=Lax` cookie, sent with the
 * provider's top-level redirect back and not to third-party contexts, so a
 * handshake an attacker started cannot be completed in another browser
 * (login CSRF).
 */
export const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function blockedByAllowlist(login: string, allowed: readonly string[] | null): boolean {
  return allowed !== null && !allowed.includes(login.toLowerCase());
}

/** A handle for a test-login account: the login lower-cased with invalid
 * characters as `_`, and a digest suffix when it is too long. */
export function testHandle(login: string): string {
  const base = login.toLowerCase().replace(/[^a-z0-9._]/gu, "_");
  if (base.length >= 3 && base.length <= 20) return base;
  const digest = Buffer.from(login).toString("hex").slice(-8);
  return `${base.slice(0, 11).padEnd(3, "_")}_${digest}`.slice(0, 20);
}

export interface AuthRoutesOptions {
  deps: ServerDeps;
  limiter: RateLimiter;
}

export function authRoutes(options: AuthRoutesOptions): Hono<AppEnv> {
  const { deps, limiter } = options;
  const { config } = deps;
  const app = new Hono<AppEnv>();
  const providerFetch = config.fixtureOAuth
    ? fixtureOAuthFetch(config)
    : (deps.fetch ?? globalThis.fetch);

  const authLimit = rateLimitByIp(limiter, "auth", abuseBuckets(config.abuse).auth);
  // The test sign-in and the fixture provider's consent page are outside the
  // budget: an end-to-end run signs in dozens of accounts from one address.
  const authBudget: MiddlewareHandler<AppEnv> = (c, next) =>
    (config.testAuthEnabled && c.req.path === "/auth/test-login") ||
    (config.fixtureOAuth && c.req.path.startsWith("/auth/fixture/"))
      ? next()
      : authLimit(c, next);
  app.use("/auth/*", authBudget);

  if (config.fixtureOAuth) {
    app.route("/", fixtureOAuthRoutes(config));
  }

  /** Writes the state row and cookie and answers the provider's URL, or
   * null when the provider is not configured. */
  const begin = (
    c: Context<AppEnv>,
    provider: SignInProvider,
    input: { returnTo: string | null; codeHash: string | null },
  ): URL | null => {
    const credentials = credentialsFor(config, provider);
    if (credentials === null) return null;
    const handshake = newHandshake();
    auth.createOAuthState(deps.db, {
      state: handshake.state,
      codeVerifier: handshake.codeVerifier,
      returnTo: input.returnTo,
      provider,
      codeHash: input.codeHash,
    });
    setCookie(c, OAUTH_STATE_COOKIE, handshake.state, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "Lax",
      path: "/auth",
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    });
    return authorizationUrl(config, provider, credentials, handshake);
  };

  const notConfigured = (provider: SignInProvider) =>
    `${PROVIDER_LABELS[provider]} sign-in is not configured on this deployment\n`;

  app.post("/auth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; returnTo?: unknown };
    const code = typeof body.code === "string" && body.code !== "" ? body.code : null;
    const url = begin(c, provider, {
      returnTo: safeReturnTo(typeof body.returnTo === "string" ? body.returnTo : null),
      codeHash: code === null ? null : accountInvites.hashOfInput(code),
    });
    if (url === null) return c.json({ error: notConfigured(provider).trim() }, 503);
    return c.json({ url: url.href });
  });

  app.get("/auth/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.notFound();
    const url = begin(c, provider, {
      returnTo: safeReturnTo(c.req.query("return_to")),
      codeHash: null,
    });
    if (url === null) return c.text(notConfigured(provider), 503);
    return c.redirect(url.href, 302);
  });

  app.get("/auth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.notFound();
    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE) ?? null;
    deleteCookie(c, OAUTH_STATE_COOKIE, {
      path: "/auth",
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "Lax",
    });
    if (!state) return c.redirect(signInError(config.publicOrigin, "missing_code"), 302);
    // Single use: the row is deleted as it is read, so a replayed callback
    // URL matches nothing (`06` §2). Consumed before any other check, so a
    // denied consent also ends the handshake.
    const stored = auth.consumeOAuthState(deps.db, state);
    if (
      !stored ||
      cookieState === null ||
      !sameState(cookieState, state) ||
      (stored.provider !== null && stored.provider !== provider)
    ) {
      return c.redirect(signInError(config.publicOrigin, "expired_state"), 302);
    }
    if (!code) {
      const reason = c.req.query("error") === "access_denied" ? "cancelled" : "missing_code";
      return c.redirect(signInError(config.publicOrigin, reason), 302);
    }
    const credentials = credentialsFor(config, provider);
    if (credentials === null) return c.text(notConfigured(provider), 503);
    const returnTo = safeReturnTo(stored.returnTo);
    const ipKey = c.get("ipKey");

    let identity: Awaited<ReturnType<typeof fetchIdentity>>;
    try {
      const token = await exchangeCode(
        providerFetch,
        config,
        provider,
        credentials,
        code,
        stored.codeVerifier,
      );
      identity = await fetchIdentity(providerFetch, config, provider, token);
    } catch (error) {
      const reason = error instanceof ProviderError ? error.reason : "profile_failed";
      c.get("logger").warn({ provider, reason, err: error }, "oauth sign-in failed");
      return c.redirect(signInError(config.publicOrigin, reason), 302);
    }

    if (provider === "github" && blockedByAllowlist(identity.login, config.allowedGithubLogins)) {
      auth.recordSignupAttempt(deps.db, ipKey, "not_allowed");
      return c.redirect(signInError(config.publicOrigin, "not_allowed"), 302);
    }

    const signIn = (userId: string, path: string) => {
      const session = auth.createSession(deps.db, userId, {
        userAgent: c.req.header("user-agent") ?? null,
      });
      setSessionCookie(c, config, session.token);
      return c.redirect(`${config.publicOrigin}${path}`, 302);
    };

    const existing = users.refreshIdentity(deps.db, identity);
    if (existing) {
      auth.recordSignupAttempt(deps.db, ipKey, "signed_in");
      return signIn(existing.id, returnTo ?? "/");
    }

    const open =
      stored.codeHash === null ? null : accountInvites.findOpenByHash(deps.db, stored.codeHash);
    if (open === null) {
      const made = auth.countSignupAttempts(deps.db, ipKey, Date.now() - DAY_MS, "waiting");
      if (made >= config.abuse.waitingPerIpPerDay) {
        auth.recordSignupAttempt(deps.db, ipKey, "waiting_refused");
        return c.redirect(signInError(config.publicOrigin, "too_many_accounts"), 302);
      }
    }
    const created = users.createWaiting(deps.db, identity, {
      signupIpHash: ipKey,
      pendingInviteId: open?.id ?? null,
    });
    if (!created.created) return signIn(created.user.id, returnTo ?? "/");
    auth.recordSignupAttempt(deps.db, ipKey, open ? "invited" : "waiting");
    // With an open invite the client opens the profile step (`auth.me`
    // reports the pending invite); without one, the "Invite required" page.
    return signIn(created.user.id, open ? (returnTo ?? "/") : NEW_WAITING_PATH);
  });

  app.post("/auth/logout", (c) => {
    const token = sessionCookieFrom(c);
    if (token) {
      endSession(deps, token);
    }
    clearSessionCookie(c, config);
    return c.body(null, 204);
  });

  if (config.testAuthEnabled) {
    // Development and test only; `loadConfig` prevents enabling this route in
    // production (`03-api-and-events.md` §5). Signs in an active account
    // with a handle derived from the login, or with `waiting: true` a new
    // waiting account, as the OAuth callback makes for an identity with no
    // invite. `spent` records that many included tokens as already spent
    // this week, one closed ledger row, so a spec can start a member near
    // the weekly allowance (`03` K3, K9; `e2e/spaces-billing.spec.ts`).
    app.post("/auth/test-login", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        login?: unknown;
        isAdmin?: unknown;
        provider?: unknown;
        waiting?: unknown;
        spent?: unknown;
      };
      const login = typeof body.login === "string" && body.login !== "" ? body.login : "tester";
      const provider = body.provider === "x" ? "x" : "github";
      const identity = {
        provider,
        providerUserId: `test:${login}`,
        login,
        name: login,
      } as const;
      let user =
        users.refreshIdentity(deps.db, identity) ??
        (body.waiting === true
          ? users.createWaiting(deps.db, identity).user
          : users.createActive(deps.db, identity, {
              handle: uniqueTestHandle(deps, login),
              displayName: login,
            }));
      if (body.isAdmin === true && !user.isAdmin && user.handle !== null) {
        user = users.setAdminByHandle(deps.db, user.handle, true);
      }
      if (typeof body.spent === "number" && Number.isSafeInteger(body.spent) && body.spent > 0)
        recordSpent(deps, user.id, body.spent);
      const session = auth.createSession(deps.db, user.id);
      setSessionCookie(c, config, session.token);
      return c.json(users.findById(deps.db, user.id));
    });
  }

  return app;
}

/** A closed `included` ledger row of `tokens` input tokens for `userId`,
 * opened now: what `test-login`'s `spent` records. Nothing without a
 * ledger. */
function recordSpent(deps: ServerDeps, userId: string, tokens: number): void {
  const ledger = deps.ledger;
  if (!ledger) return;
  const at = (deps.now ?? Date.now)();
  const counts = { ...ZERO_COUNTS, inputTokens: tokens };
  const id = ledger.open({
    runId: `test-login-${userId}-${at}`,
    attempt: 1,
    userId,
    payer: "included",
    week: weekOf(at),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 1,
    counts,
    openedAt: at,
  });
  ledger.close(id, counts, "finish", at);
}

/** `testHandle(login)`, or with a numeric suffix when another account holds
 * it. */
function uniqueTestHandle(deps: ServerDeps, login: string): string {
  const base = testHandle(login);
  if (users.handleAvailable(deps.db, base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    if (isAccountHandle(candidate) && users.handleAvailable(deps.db, candidate)) return candidate;
  }
}
