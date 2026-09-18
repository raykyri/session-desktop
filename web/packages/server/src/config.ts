// Deployment configuration: every variable in `web/.env.example`, validated
// once at boot (`04-agent-runtime.md` §11, `13-deployment-fly.md` §5).
//
// The process refuses to start on a malformed value rather than discovering it
// on the first request: a bad `SESSION_PUBLIC_ORIGIN` is a broken OAuth
// callback and a broken CSRF check, and both fail in ways that look like
// something else.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

/** `1`/`0`, `true`/`false`, `yes`/`no`; an empty value is the default. */
const flag = (fallback: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
        return true;
      }
      if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
        return false;
      }
      ctx.addIssue({ code: "custom", message: `expected a boolean, got ${JSON.stringify(value)}` });
      return z.NEVER;
    });

const positiveInteger = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message: `expected a non-negative integer, got ${value}` });
        return z.NEVER;
      }
      return parsed;
    });

/** A value that is absent, empty, or a non-empty string; `""` becomes null so
 * an unset Fly secret and a blank one behave the same. */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value));

/**
 * An `http(s)` origin with no credentials, path, query, or fragment — the
 * landing server's `validatedPublicOrigin` (`web/server.tsx:106-119`), kept
 * because the same three consumers depend on it: the OAuth callback URL, the
 * CSRF origin comparison, and the OpenRouter attribution header.
 */
export function validatedOrigin(value: string, name: string): string {
  const parsed = URL.parse(value);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without a path.`);
  }
  return parsed.origin;
}

const originSchema = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .transform((value, ctx) => {
      try {
        return validatedOrigin(value, name);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    });

const envSchema = z.object({
  HOST: z.string().trim().default("127.0.0.1"),
  PORT: positiveInteger(8787),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  SESSION_PUBLIC_ORIGIN: originSchema("SESSION_PUBLIC_ORIGIN"),
  SESSION_ARTIFACT_ORIGIN: originSchema("SESSION_ARTIFACT_ORIGIN"),
  SESSION_DATA_DIR: z.string().trim().default("./.data"),

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  SESSION_ALLOWED_GITHUB_LOGINS: optionalString,
  SESSION_REQUIRE_INVITE: flag(false),

  GOOGLE_APPLICATION_CREDENTIALS_JSON: optionalString,
  GOOGLE_VERTEX_PROJECT: optionalString,
  GOOGLE_VERTEX_LOCATION: z.string().trim().default("global"),
  OPENROUTER_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,

  PARALLEL_API_KEY: optionalString,
  TAVILY_API_KEY: optionalString,
  SESSION_SEARCH_VENDOR: z.enum(["parallel", "tavily"]).default("parallel"),

  SESSION_RUNS_PER_USER: positiveInteger(2),
  SESSION_RUNS_GEMINI: positiveInteger(8),
  SESSION_RUNS_OPENROUTER: positiveInteger(8),
  SESSION_RUNS_ANTHROPIC: positiveInteger(2),
  SESSION_RUN_TIMEOUT_SECONDS: positiveInteger(900),

  SESSION_ENFORCE_LIMITS: flag(false),
  SESSION_DAILY_TOKENS: positiveInteger(1_000_000),
  SESSION_DAILY_RUNS: positiveInteger(10),

  LITESTREAM_REPLICA_URL: optionalString,
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  SENTRY_DSN: optionalString,
  SESSION_METRICS_TOKEN: optionalString,

  SESSION_FIXTURE_PROVIDERS: flag(false),
  SESSION_TEST_AUTH: flag(false),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface RunLimits {
  perUser: number;
  vertex: number;
  openrouter: number;
  anthropic: number;
  runTimeoutMs: number;
  enforceDailyLimits: boolean;
  dailyTokens: number;
  dailyRuns: number;
}

/** Which providers have a credential. A model whose provider is missing is
 * reported `available: false` by `system.runtimeConfig` and refused at launch
 * (`04-agent-runtime.md` §11). */
export interface ProviderCredentials {
  vertex: boolean;
  openrouter: boolean;
  anthropic: boolean;
}

export interface Config {
  env: RawEnv["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;

  publicOrigin: string;
  artifactOrigin: string;
  /** Host (with port) of the artifact origin, for the `Host` check on `/a/:token`. */
  artifactHost: string;

  dataDir: string;
  databasePath: string;
  documentsDir: string;
  tmpDir: string;

  github: { clientId: string | null; clientSecret: string | null; callbackUrl: string };
  allowedGithubLogins: string[] | null;
  requireInvite: boolean;
  testAuthEnabled: boolean;

  vertex: { credentialsJson: string | null; project: string | null; location: string };
  openrouterApiKey: string | null;
  anthropicApiKey: string | null;
  fixtureProviders: boolean;
  credentials: ProviderCredentials;

  search: {
    parallelApiKey: string | null;
    tavilyApiKey: string | null;
    vendor: "parallel" | "tavily";
  };

  limits: RunLimits;

  litestreamReplicaUrl: string | null;
  sentryDsn: string | null;
  metricsToken: string | null;
}

/** Raised with every offending variable at once; a deploy that is missing
 * three secrets should say so in one line rather than three restarts. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function splitLogins(value: string | null): string[] | null {
  if (value === null) {
    return null;
  }
  const logins = value
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
  return logins.length === 0 ? null : logins;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const value = parsed.data;
  const dataDir = isAbsolute(value.SESSION_DATA_DIR)
    ? value.SESSION_DATA_DIR
    : resolve(process.cwd(), value.SESSION_DATA_DIR);
  const fixtureProviders = value.SESSION_FIXTURE_PROVIDERS;
  const vertexConfigured =
    value.GOOGLE_APPLICATION_CREDENTIALS_JSON !== null && value.GOOGLE_VERTEX_PROJECT !== null;
  if (value.GOOGLE_APPLICATION_CREDENTIALS_JSON !== null) {
    try {
      JSON.parse(value.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    } catch {
      throw new ConfigError([
        "GOOGLE_APPLICATION_CREDENTIALS_JSON: expected the service-account key as one line of JSON",
      ]);
    }
  }
  return {
    env: value.NODE_ENV,
    isProduction: value.NODE_ENV === "production",
    host: value.HOST,
    port: value.PORT,

    publicOrigin: value.SESSION_PUBLIC_ORIGIN,
    artifactOrigin: value.SESSION_ARTIFACT_ORIGIN,
    artifactHost: new URL(value.SESSION_ARTIFACT_ORIGIN).host,

    dataDir,
    databasePath: join(dataDir, "session.db"),
    documentsDir: join(dataDir, "documents"),
    tmpDir: join(dataDir, "tmp"),

    github: {
      clientId: value.GITHUB_CLIENT_ID,
      clientSecret: value.GITHUB_CLIENT_SECRET,
      callbackUrl: `${value.SESSION_PUBLIC_ORIGIN}/auth/github/callback`,
    },
    allowedGithubLogins: splitLogins(value.SESSION_ALLOWED_GITHUB_LOGINS),
    requireInvite: value.SESSION_REQUIRE_INVITE,
    // Never in production, whatever the variable says (`03-api-and-events.md` §5).
    testAuthEnabled: value.SESSION_TEST_AUTH && value.NODE_ENV !== "production",

    vertex: {
      credentialsJson: value.GOOGLE_APPLICATION_CREDENTIALS_JSON,
      project: value.GOOGLE_VERTEX_PROJECT,
      location: value.GOOGLE_VERTEX_LOCATION,
    },
    openrouterApiKey: value.OPENROUTER_API_KEY,
    anthropicApiKey: value.ANTHROPIC_API_KEY,
    fixtureProviders,
    credentials: {
      vertex: fixtureProviders || vertexConfigured,
      openrouter: fixtureProviders || value.OPENROUTER_API_KEY !== null,
      anthropic: fixtureProviders || value.ANTHROPIC_API_KEY !== null,
    },

    search: {
      parallelApiKey: value.PARALLEL_API_KEY,
      tavilyApiKey: value.TAVILY_API_KEY,
      vendor: value.SESSION_SEARCH_VENDOR,
    },

    limits: {
      perUser: value.SESSION_RUNS_PER_USER,
      vertex: value.SESSION_RUNS_GEMINI,
      openrouter: value.SESSION_RUNS_OPENROUTER,
      anthropic: value.SESSION_RUNS_ANTHROPIC,
      runTimeoutMs: value.SESSION_RUN_TIMEOUT_SECONDS * 1000,
      enforceDailyLimits: value.SESSION_ENFORCE_LIMITS,
      dailyTokens: value.SESSION_DAILY_TOKENS,
      dailyRuns: value.SESSION_DAILY_RUNS,
    },

    litestreamReplicaUrl: value.LITESTREAM_REPLICA_URL,
    sentryDsn: value.SENTRY_DSN,
    metricsToken: value.SESSION_METRICS_TOKEN,
  };
}

/**
 * Loads `web/.env` in development, the way `npm run dev` expects
 * (`13-deployment-fly.md` §8). Production reads `fly.toml [env]` and Fly
 * secrets, so a stray `.env` in the image is ignored rather than trusted.
 */
/**
 * The nearest `.env` at or above `from`, or null. npm runs a workspace script
 * with the cwd set to that package, so a server started through
 * `npm run dev` sits two directories below the `.env` beside the workspace
 * root; searching upward finds it from either place.
 */
export function findDotenvFile(from: string = process.cwd()): string | null {
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export function loadDotenvForDevelopment(
  path: string | null = findDotenvFile(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["NODE_ENV"] === "production" || path === null || !existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}
