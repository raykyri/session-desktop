// GitHub sign-in (`06-auth-and-users.md` §2, §3). Plain Hono routes rather
// than tRPC: the flow is two browser redirects, not two RPCs.

import { timingSafeEqual } from "node:crypto";

import { auth, users } from "@session/db";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AppEnv, ServerDeps } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { RATE_LIMITS, rateLimitByIp } from "../middleware/rateLimit.js";
import { removeUserDocuments } from "../uploads/storage.js";

import {
  clearSessionCookie,
  hashClientIp,
  sessionCookieFrom,
  setSessionCookie,
} from "./session.js";

const AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const PROFILE_ENDPOINT = "https://api.github.com/user";

/** How long `api.github.com` has to answer before the sign-in is abandoned. */
const PROFILE_TIMEOUT_MS = 10_000;

/** `read:user` rather than the desktop's empty scope: the profile fields the
 * account row keeps (`created_at`, `name`) need it, and it grants no writes. */
const SCOPES = ["read:user"];

export interface GitHubProfileResponse {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  created_at?: string | null;
}

/** A backslash (Windows browsers normalize it to a slash) or a control
 * character, which would let a return path smuggle a second header line. */
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
 * A same-origin path to return to after sign-in. Anything else — an absolute
 * URL, a protocol-relative `//host`, a backslash Windows browsers normalize to
 * a slash — is dropped rather than corrected.
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

/** `oauth_states` carries one text column for the round trip, so the return
 * path and the invite code travel in it together. A bare path is still
 * accepted so a row written by an older build redirects as it used to. */
function encodeStatePayload(returnTo: string | null, invite: string | null): string | null {
  if (returnTo === null && invite === null) {
    return null;
  }
  return JSON.stringify({ returnTo, invite });
}

function decodeStatePayload(value: string | null): {
  returnTo: string | null;
  invite: string | null;
} {
  if (value === null || value === "") {
    return { returnTo: null, invite: null };
  }
  if (!value.startsWith("{")) {
    return { returnTo: safeReturnTo(value), invite: null };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return { returnTo: null, invite: null };
    }
    const record = parsed as Record<string, unknown>;
    const invite = record["invite"];
    return {
      returnTo: safeReturnTo(typeof record["returnTo"] === "string" ? record["returnTo"] : null),
      invite: typeof invite === "string" && invite !== "" ? invite : null,
    };
  } catch {
    return { returnTo: null, invite: null };
  }
}

/** GitHub's `created_at` is ISO 8601; the column is epoch milliseconds. */
function githubCreatedAt(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function blockedByAllowlist(login: string, allowed: readonly string[] | null): boolean {
  return allowed !== null && !allowed.includes(login.toLowerCase());
}

/** The slice of `arctic`'s `OAuth2Client` this module uses, named so a test
 * can substitute one without a network. */
export interface OAuthClient {
  authorizationUrl(state: string, codeVerifier: string): URL;
  exchange(code: string, codeVerifier: string): Promise<string>;
}

export interface GitHubRoutesOptions {
  deps: ServerDeps;
  limiter: RateLimiter;
  createClient?: (deps: ServerDeps) => OAuthClient;
}

async function arcticClient(deps: ServerDeps): Promise<OAuthClient> {
  const { CodeChallengeMethod, OAuth2Client } = await import("arctic");
  const client = new OAuth2Client(
    deps.config.github.clientId ?? "",
    deps.config.github.clientSecret,
    deps.config.github.callbackUrl,
  );
  return {
    authorizationUrl: (state, codeVerifier) =>
      client.createAuthorizationURLWithPKCE(
        AUTHORIZATION_ENDPOINT,
        state,
        CodeChallengeMethod.S256,
        codeVerifier,
        SCOPES,
      ),
    exchange: async (code, codeVerifier) => {
      const tokens = await client.validateAuthorizationCode(TOKEN_ENDPOINT, code, codeVerifier);
      return tokens.accessToken();
    },
  };
}

function signInError(publicOrigin: string, reason: string): string {
  return `${publicOrigin}/login?error=${encodeURIComponent(reason)}`;
}

/**
 * The state is also kept in a `SameSite=Lax` cookie, which a top-level
 * redirect from GitHub carries and a third-party page cannot write. Without it
 * a handshake the attacker started could be finished in someone else's
 * browser, signing that person into the attacker's account.
 */
export const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function githubRoutes(options: GitHubRoutesOptions): Hono<AppEnv> {
  const { deps, limiter } = options;
  const { config } = deps;
  const app = new Hono<AppEnv>();
  const doFetch = deps.fetch ?? globalThis.fetch;
  let client: Promise<OAuthClient> | null = null;
  const oauthClient = (): Promise<OAuthClient> => {
    client ??= options.createClient
      ? Promise.resolve(options.createClient(deps))
      : arcticClient(deps);
    return client;
  };

  app.use("/auth/*", rateLimitByIp(limiter, "auth", RATE_LIMITS.auth));

  app.get("/auth/github", async (c) => {
    if (config.github.clientId === null || config.github.clientSecret === null) {
      return c.text("GitHub sign-in is not configured on this deployment\n", 503);
    }
    const { generateCodeVerifier, generateState } = await import("arctic");
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const returnTo = safeReturnTo(c.req.query("return_to"));
    const invite = c.req.query("invite") ?? null;
    auth.createOAuthState(deps.db, {
      state,
      codeVerifier,
      returnTo: encodeStatePayload(returnTo, invite === "" ? null : invite),
    });
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "Lax",
      path: "/auth",
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    });
    const url = (await oauthClient()).authorizationUrl(state, codeVerifier);
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/github/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.redirect(signInError(config.publicOrigin, "missing_code"), 302);
    }
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE) ?? null;
    deleteCookie(c, OAUTH_STATE_COOKIE, {
      path: "/auth",
      httpOnly: true,
      secure: config.isProduction,
      sameSite: "Lax",
    });
    // Single use: the row is deleted by the read, so a replayed callback URL
    // finds nothing (`06-auth-and-users.md` §2).
    const stored = auth.consumeOAuthState(deps.db, state);
    if (!stored || cookieState === null || !sameState(cookieState, state)) {
      return c.redirect(signInError(config.publicOrigin, "expired_state"), 302);
    }
    const { returnTo, invite } = decodeStatePayload(stored.returnTo);
    const ipHash = hashClientIp(config, c.get("clientIp"));

    let accessToken: string;
    try {
      accessToken = await (await oauthClient()).exchange(code, stored.codeVerifier);
    } catch (error) {
      c.get("logger").warn({ error }, "github code exchange failed");
      return c.redirect(signInError(config.publicOrigin, "exchange_failed"), 302);
    }

    const response = await doFetch(PROFILE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "session",
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) {
      c.get("logger").warn({ status: response.status }, "github profile fetch failed");
      return c.redirect(signInError(config.publicOrigin, "profile_failed"), 302);
    }
    const profile = (await response.json()) as GitHubProfileResponse;
    if (typeof profile.id !== "number" || typeof profile.login !== "string") {
      return c.redirect(signInError(config.publicOrigin, "profile_failed"), 302);
    }

    if (blockedByAllowlist(profile.login, config.allowedGithubLogins)) {
      auth.recordSignupAttempt(deps.db, ipHash, "not_allowed");
      return c.redirect(signInError(config.publicOrigin, "not_allowed"), 302);
    }

    const existing = users.findByGitHubId(deps.db, profile.id);
    if (existing === null && config.requireInvite && invite === null) {
      auth.recordSignupAttempt(deps.db, ipHash, "invite_required");
      return c.redirect(signInError(config.publicOrigin, "invite_required"), 302);
    }

    const { user, created } = users.upsertFromGitHub(
      deps.db,
      {
        githubId: profile.id,
        login: profile.login,
        name: profile.name ?? null,
        avatarUrl: profile.avatar_url ?? null,
        githubCreatedAt: githubCreatedAt(profile.created_at),
      },
      { signupIpHash: ipHash },
    );

    if (created && config.requireInvite) {
      const redeemed = invite !== null && auth.redeemInvite(deps.db, invite, user.id);
      if (!redeemed) {
        // The row exists only because this sign-up was in progress; an
        // unusable invite must not leave an account behind. The cascade takes
        // the `documents` rows and with them any way of naming the files, so
        // the paths are read first and unlinked after.
        await removeUserDocuments(deps, user.id, c.get("logger"), () =>
          users.removeUser(deps.db, user.id),
        );
        auth.recordSignupAttempt(deps.db, ipHash, "invite_invalid");
        return c.redirect(signInError(config.publicOrigin, "invite_invalid"), 302);
      }
    }
    auth.recordSignupAttempt(deps.db, ipHash, created ? "created" : "signed_in");

    const session = auth.createSession(deps.db, user.id, {
      userAgent: c.req.header("user-agent") ?? null,
    });
    setSessionCookie(c, config, session.token);
    return c.redirect(`${config.publicOrigin}${returnTo ?? "/"}`, 302);
  });

  app.post("/auth/logout", (c) => {
    const token = sessionCookieFrom(c);
    if (token) {
      auth.deleteSession(deps.db, token);
    }
    clearSessionCookie(c, config);
    return c.body(null, 204);
  });

  if (config.testAuthEnabled) {
    // Development and test only; `loadConfig` refuses to enable it in
    // production (`03-api-and-events.md` §5).
    app.post("/auth/test-login", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        login?: unknown;
        isAdmin?: unknown;
        githubId?: unknown;
      };
      const login = typeof body.login === "string" && body.login !== "" ? body.login : "tester";
      const githubId =
        typeof body.githubId === "number"
          ? body.githubId
          : // Stable per login, so repeated test logins reuse one account.
            Number(BigInt(`0x${Buffer.from(login, "utf8").toString("hex")}`) % 1000000007n);
      const { user } = users.upsertFromGitHub(deps.db, { githubId, login, name: login });
      if (body.isAdmin === true && !user.isAdmin) {
        users.setAdmin(deps.db, login, true);
      }
      const session = auth.createSession(deps.db, user.id);
      setSessionCookie(c, config, session.token);
      return c.json(users.findById(deps.db, user.id));
    });
  }

  return app;
}
