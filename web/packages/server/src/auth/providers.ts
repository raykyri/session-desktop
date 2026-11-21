// The two sign-in providers, GitHub and X, both OAuth 2.0 authorization
// code with PKCE (plan `04` Z2; `06-auth-and-users.md` §2).
//
// Written against `fetch` rather than an OAuth library so every request the
// server makes to a provider goes through one injectable function: the
// callback tests answer the real endpoints with fixtures, and the
// end-to-end suite answers the fixture endpoints of `fixtureOAuth.ts`.
//
// - GitHub: scopes `read:user` and `user:email`; `GET /user` for the id,
//   login, name, avatar and account age, `GET /user/emails` for the primary
//   verified address.
// - X: scopes `users.read`, `tweet.read` (X requires it to read the user)
//   and `users.email`; `GET /2/users/me` with `user.fields=created_at,
//   profile_image_url,confirmed_email`. The token endpoint takes the client
//   credentials as HTTP Basic, X's confidential-client form.

import { createHash, randomBytes } from "node:crypto";

import type { users } from "@session/db";
import type { SignInProvider } from "@session/shared";

import type { Config } from "../config.js";

type ProviderIdentity = users.ProviderIdentity;

/** HTTP timeout for every provider request. */
const PROVIDER_TIMEOUT_MS = 10_000;

export interface ProviderEndpoints {
  authorize: string;
  token: string;
  profile: string;
  /** GitHub only: the addresses of the account. */
  emails?: string;
}

const REAL_ENDPOINTS: Record<SignInProvider, ProviderEndpoints> = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    profile: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  },
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    profile:
      "https://api.x.com/2/users/me?user.fields=created_at,profile_image_url,confirmed_email",
  },
};

/** The fixture endpoints `fixtureOAuth.ts` serves under
 * `SESSION_FIXTURE_OAUTH=1` (end-to-end only). */
export function fixtureEndpoints(origin: string, provider: SignInProvider): ProviderEndpoints {
  const base = `${origin}/auth/fixture/${provider}`;
  return provider === "github"
    ? {
        authorize: `${base}/authorize`,
        token: `${base}/token`,
        profile: `${base}/user`,
        emails: `${base}/user/emails`,
      }
    : { authorize: `${base}/authorize`, token: `${base}/token`, profile: `${base}/users/me` };
}

const SCOPES: Record<SignInProvider, string> = {
  github: "read:user user:email",
  x: "users.read tweet.read users.email",
};

export const PROVIDER_LABELS: Record<SignInProvider, string> = { github: "GitHub", x: "X" };

export function isProvider(value: string | undefined): value is SignInProvider {
  return value === "github" || value === "x";
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** The deployment's credentials for `provider`, or null when sign-in with it
 * is not configured. */
export function credentialsFor(config: Config, provider: SignInProvider): ClientCredentials | null {
  const settings = provider === "github" ? config.github : config.x;
  if (config.fixtureOAuth) {
    return {
      clientId: settings.clientId ?? `fixture-${provider}`,
      clientSecret: settings.clientSecret ?? "fixture-secret",
      callbackUrl: settings.callbackUrl,
    };
  }
  if (settings.clientId === null || settings.clientSecret === null) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    callbackUrl: settings.callbackUrl,
  };
}

export function endpointsFor(config: Config, provider: SignInProvider): ProviderEndpoints {
  return config.fixtureOAuth
    ? fixtureEndpoints(config.publicOrigin, provider)
    : REAL_ENDPOINTS[provider];
}

/** A PKCE pair and a state value, each 256 random bits. */
export function newHandshake(): { state: string; codeVerifier: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(32).toString("base64url"),
  };
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function authorizationUrl(
  config: Config,
  provider: SignInProvider,
  credentials: ClientCredentials,
  handshake: { state: string; codeVerifier: string },
): URL {
  const url = new URL(endpointsFor(config, provider).authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", credentials.callbackUrl);
  url.searchParams.set("scope", SCOPES[provider]);
  url.searchParams.set("state", handshake.state);
  url.searchParams.set("code_challenge", codeChallenge(handshake.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export class ProviderError extends Error {
  readonly reason: "exchange_failed" | "profile_failed";

  constructor(reason: "exchange_failed" | "profile_failed", message: string) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
  }
}

/** Exchanges the authorization code for an access token. */
export async function exchangeCode(
  fetchImpl: typeof globalThis.fetch,
  config: Config,
  provider: SignInProvider,
  credentials: ClientCredentials,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: credentials.callbackUrl,
    code_verifier: codeVerifier,
    client_id: credentials.clientId,
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "session",
  };
  if (provider === "x") {
    headers["Authorization"] =
      `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_secret", credentials.clientSecret);
  }
  let response: Response;
  try {
    response = await fetchImpl(endpointsFor(config, provider).token, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError("exchange_failed", `token request failed: ${String(error)}`);
  }
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || typeof payload?.access_token !== "string" || payload.access_token === "") {
    throw new ProviderError(
      "exchange_failed",
      `token endpoint answered ${response.status}${typeof payload?.error === "string" ? ` (${payload.error})` : ""}`,
    );
  }
  return payload.access_token;
}

/** Avatars come only from the providers' image hosts over https; anything
 * else is dropped and the client draws initials (04 Z5). */
const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "pbs.twimg.com", "abs.twimg.com"]);

export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = URL.parse(value);
  return url && url.protocol === "https:" && AVATAR_HOSTS.has(url.hostname) ? url.href : null;
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : null;
}

async function getJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  accessToken: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "session",
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError("profile_failed", `profile request failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new ProviderError("profile_failed", `${url} answered ${response.status}`);
  }
  return response.json();
}

/** Reads the signed-in person from the provider. */
export async function fetchIdentity(
  fetchImpl: typeof globalThis.fetch,
  config: Config,
  provider: SignInProvider,
  accessToken: string,
): Promise<ProviderIdentity> {
  const endpoints = endpointsFor(config, provider);
  if (provider === "github") {
    const profile = (await getJson(fetchImpl, endpoints.profile, accessToken)) as Record<
      string,
      unknown
    >;
    if (typeof profile["id"] !== "number" || typeof profile["login"] !== "string") {
      throw new ProviderError("profile_failed", "the GitHub profile has no id or login");
    }
    let email: string | null = null;
    if (endpoints.emails) {
      try {
        const emails = await getJson(fetchImpl, endpoints.emails, accessToken);
        if (Array.isArray(emails)) {
          const primary = (emails as Record<string, unknown>[]).find(
            (entry) => entry["primary"] === true && entry["verified"] === true,
          );
          email = text(primary?.["email"], 320);
        }
      } catch {
        // An account without the scope granted, or a transient failure:
        // the address is optional and refreshed at the next sign-in.
        email = null;
      }
    }
    return {
      provider,
      providerUserId: String(profile["id"]),
      login: profile["login"],
      name: text(profile["name"]),
      avatarUrl: safeAvatarUrl(profile["avatar_url"]),
      email,
      providerCreatedAt: isoTime(profile["created_at"]),
    };
  }
  const payload = (await getJson(fetchImpl, endpoints.profile, accessToken)) as {
    data?: Record<string, unknown>;
  };
  const data = payload.data;
  if (!data || typeof data["id"] !== "string" || typeof data["username"] !== "string") {
    throw new ProviderError("profile_failed", "the X profile has no id or username");
  }
  return {
    provider,
    providerUserId: data["id"],
    login: data["username"],
    name: text(data["name"]),
    avatarUrl: safeAvatarUrl(data["profile_image_url"]),
    email: text(data["confirmed_email"], 320),
    providerCreatedAt: isoTime(data["created_at"]),
  };
}
