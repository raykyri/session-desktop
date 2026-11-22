// Deployment configuration: every variable in `web/.env.example`, validated
// once at boot (`04-agent-runtime.md` §11, `13-deployment-fly.md` §5).
//
// The process does not start with a malformed value rather than discovering it
// on the first request: a bad `SESSION_PUBLIC_ORIGIN` is a broken OAuth
// callback and a broken CSRF check, and both fail in ways that look like
// something else.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUMMARY_WINDOW,
  WEB_WINDOW,
  type CursorKeys,
  type WindowSettings,
} from "@session/sync/server";
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

/** An integer variable, at least `minimum` (0 unless given) and at most
 * `maximum` when given. */
const positiveInteger = (fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        ctx.addIssue({
          code: "custom",
          message:
            maximum !== Number.MAX_SAFE_INTEGER
              ? `expected an integer from ${minimum} to ${maximum}, got ${value}`
              : minimum === 0
                ? `expected a non-negative integer, got ${value}`
                : `expected an integer of at least ${minimum}, got ${value}`,
        });
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

/** Upper bounds of the size settings: beyond them a typo, not a choice. */
const MAX_APPLY_BYTES = 64 * 1024 * 1024;
const MAX_APPLY_BATCH = 1000;
const MAX_WINDOW_DAYS = 3650;
const MAX_WINDOW_THREADS = 10_000;
const SUMMARY_DAYS = SUMMARY_WINDOW / 86_400_000;

const envSchema = z.object({
  HOST: z.string().trim().default("127.0.0.1"),
  PORT: positiveInteger(8787),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  SESSION_PUBLIC_ORIGIN: originSchema("SESSION_PUBLIC_ORIGIN"),
  SESSION_DATA_DIR: z.string().trim().default("./.data"),

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  SESSION_ALLOWED_GITHUB_LOGINS: optionalString,
  SESSION_X_CLIENT_ID: optionalString,
  SESSION_X_CLIENT_SECRET: optionalString,

  // Abuse limits (`04` Z1); the defaults are the plan's.
  SESSION_LIMIT_WRITES_PER_MINUTE: positiveInteger(60, 1),
  SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: positiveInteger(30, 1),
  SESSION_LIMIT_AUTH_PER_MINUTE: positiveInteger(20, 1),
  SESSION_LIMIT_FAILED_CHECKS_PER_HOUR: positiveInteger(10, 1),
  SESSION_LIMIT_WAITING_PER_IP_PER_DAY: positiveInteger(5, 1),
  // Account invites each member gets in all, before any a site admin gives
  // (`04` I2).
  SESSION_INVITES_PER_MEMBER: positiveInteger(3, 1),
  SESSION_LIMIT_INVITES_PER_DAY: positiveInteger(10, 1),
  SESSION_LIMIT_INVITE_READS_PER_MINUTE: positiveInteger(60, 1),
  SESSION_LIMIT_HANDLE_CHECKS_PER_MINUTE: positiveInteger(30, 1),
  SESSION_LIMIT_SPACES_PER_DAY: positiveInteger(5, 1),
  SESSION_LIMIT_CHANNEL_INVITES_PER_DAY: positiveInteger(20, 1),
  SESSION_LIMIT_JOINS_PER_HOUR: positiveInteger(60, 1),
  SESSION_LIMIT_DIRECTORY_PER_MINUTE: positiveInteger(60, 1),
  SESSION_LIMIT_ADMIN_PER_MINUTE: positiveInteger(60, 1),
  SESSION_LIMIT_BY_NAME_PER_MINUTE: positiveInteger(30, 1),
  // Sync transport limits (`01` A3).
  SESSION_LIMIT_THREAD_READS_PER_MINUTE: positiveInteger(120, 1),
  SESSION_LIMIT_THREAD_READS_PER_IP_PER_MINUTE: positiveInteger(240, 1),
  SESSION_LIMIT_REGISTER_PER_MINUTE: positiveInteger(10, 1),
  SESSION_LIMIT_STREAMS_PER_USER: positiveInteger(10, 1),
  SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: positiveInteger(30, 1),
  SESSION_LIMIT_APPLY_BYTES: positiveInteger(4 * 1024 * 1024, 1024, MAX_APPLY_BYTES),
  SESSION_LIMIT_APPLY_BATCH: positiveInteger(100, 1, MAX_APPLY_BATCH),

  // The sync protocol (`01` S1, Y6, R1; `05` §3.4).
  SESSION_MIN_PROTOCOL: positiveInteger(MIN_PROTOCOL_VERSION, 1),
  SESSION_CURSOR_KEY: optionalString,
  SESSION_CURSOR_KEY_PREVIOUS: optionalString,
  SESSION_CURSOR_KEY_ROTATED_AT: optionalString,
  SESSION_WEB_WINDOW_DAYS: positiveInteger(WEB_WINDOW.days, 1, MAX_WINDOW_DAYS),
  SESSION_WEB_WINDOW_THREADS: positiveInteger(WEB_WINDOW.threads, 1, MAX_WINDOW_THREADS),
  SESSION_WEB_WINDOW_CAP: positiveInteger(WEB_WINDOW.cap, 1, MAX_WINDOW_THREADS),
  // How far back a summary reaches (`01` R1); a test server sets it low to
  // have threads that no tier of a snapshot serves.
  SESSION_WEB_SUMMARY_DAYS: positiveInteger(SUMMARY_DAYS, 0, MAX_WINDOW_DAYS),

  GOOGLE_APPLICATION_CREDENTIALS_JSON: optionalString,
  GOOGLE_VERTEX_PROJECT: optionalString,
  GOOGLE_VERTEX_LOCATION: z.string().trim().default("global"),
  OPENROUTER_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,

  PARALLEL_API_KEY: optionalString,
  TAVILY_API_KEY: optionalString,
  SESSION_SEARCH_VENDOR: z.enum(["parallel", "tavily"]).default("parallel"),

  // Concurrency caps and the queue bound: 0 would admit nothing, and runs
  // would wait in the queue for good, so each is at least 1.
  SESSION_RUNS_PER_USER: positiveInteger(2, 1),
  SESSION_QUEUED_PER_USER: positiveInteger(20, 1),
  SESSION_RUNS_GEMINI: positiveInteger(8, 1),
  SESSION_RUNS_OPENROUTER: positiveInteger(8, 1),
  SESSION_RUNS_ANTHROPIC: positiveInteger(2, 1),
  SESSION_RUN_TIMEOUT_SECONDS: positiveInteger(900),

  // Included tokens (`03-agents-and-research.md` K3, K9, L1).
  SESSION_WEEKLY_TOKENS: positiveInteger(2_000_000),
  SESSION_OVERDRAFT_TOKENS: positiveInteger(200_000),
  SESSION_RUN_MAX_TOKENS: positiveInteger(400_000, 1),

  LITESTREAM_REPLICA_URL: optionalString,
  SESSION_DOCUMENTS_REPLICA_URL: optionalString,
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  SENTRY_DSN: optionalString,
  SESSION_METRICS_TOKEN: optionalString,

  // AES-256-GCM key for stored secrets (members' API keys, `03` K4): 32
  // bytes as 64 hex digits or base64. Required in production.
  SESSION_SECRET_KEY: optionalString,

  SESSION_FIXTURE_PROVIDERS: flag(false),
  SESSION_TEST_AUTH: flag(false),
  // The acceptance suite's test access (`/api/sync/test/*`, `01` A1): only
  // with NODE_ENV=test and a loopback public origin.
  SESSION_TEST_ROUTES: flag(false),
  // Fixture OAuth endpoints served by this server (`auth/fixtureOAuth.ts`),
  // for the end-to-end suite. Never in production.
  SESSION_FIXTURE_OAUTH: flag(false),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface RunLimits {
  perUser: number;
  /** Nodes one account may have *waiting* at once. The per-user concurrency
   * cap bounds what runs; without this nothing bounds what is admitted, and a
   * queue is spend that has already been committed to
   * (`06-auth-and-users.md` §8). */
  queuedPerUser: number;
  vertex: number;
  openrouter: number;
  anthropic: number;
  runTimeoutMs: number;
  /** Included tokens per member per week (`03` K3). */
  weeklyTokens: number;
  /** Tokens past the allowance a member's included-token runs may spend in a
   * week, shared by all of them (`03` K9). */
  overdraftTokens: number;
  /** Counted tokens one run may spend, whoever pays (`03` L1). */
  runMaxTokens: number;
}

/** Which providers have a credential. A model whose provider is missing is
 * reported `available: false` by `system.runtimeConfig` and refused at launch
 * (`04-agent-runtime.md` §11). */
export interface ProviderCredentials {
  vertex: boolean;
  openrouter: boolean;
  anthropic: boolean;
  /** Always false: OpenAI models run only on a member's own key
   * (`03` K11), never on a deployment credential. */
  openai: boolean;
}

/** The abuse limits of `04` Z1, validated at boot. Rates are per window; the
 * window is in each name. */
export interface AbuseLimits {
  writesPerMinute: number;
  snapshotsPerMinute: number;
  authPerMinute: number;
  failedChecksPerHour: number;
  waitingPerIpPerDay: number;
  /** Account invites each member gets in all (`SESSION_INVITES_PER_MEMBER`,
   * `04` I2); site admins give more per member (`user_limits.extra_invites`). */
  invitesPerMember: number;
  invitesPerDay: number;
  inviteReadsPerMinute: number;
  handleChecksPerMinute: number;
  /** `spaces.create` per user (`pre`). */
  spacesPerDay: number;
  /** `invites.create` (channel invite links) per user (`pre`). */
  channelInvitesPerDay: number;
  /** `spaces.join` per user (`pre`). */
  joinsPerHour: number;
  /** `spaces.directory` and `spaces.byName` per user, or per IP signed out. */
  directoryPerMinute: number;
  /** `admin.models.*` and `admin.invites.*` per site admin. */
  adminPerMinute: number;
  /** `POST /api/sync/register` per user (`01` A3). */
  registerPerMinute: number;
  /** Open `/api/sync/events` streams per user; one per client id. */
  streamsPerUser: number;
  /** Stream opens per user per minute. */
  streamOpensPerMinute: number;
  /** `POST /api/sync/read` of `threads` reads only, per user, and per IP
   * signed out, per minute. */
  threadReadsPerMinute: number;
  threadReadsPerIpPerMinute: number;
  /** `spaces.byName` per user or IP per minute (with the directory's). */
  byNamePerMinute: number;
  /** The largest `POST /api/sync/apply` body, and the most envelopes in it. */
  applyBytes: number;
  applyBatch: number;
}

/** The sync protocol's settings (`01` S1, S3, Y6, R1). */
export interface SyncConfig {
  /** `SESSION_MIN_PROTOCOL`: a request below it answers 426. */
  minProtocol: number;
  /** The protocol version this build speaks. */
  protocol: number;
  /** `SESSION_CURSOR_KEY`, and the previous key with the time of the
   * rotation (accepted 30 days after it). */
  cursorKeys: CursorKeys;
  /** The web window of a `window` snapshot. */
  window: WindowSettings;
}

export interface Config {
  env: RawEnv["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;

  publicOrigin: string;

  dataDir: string;
  databasePath: string;
  documentsDir: string;
  tmpDir: string;

  github: { clientId: string | null; clientSecret: string | null; callbackUrl: string };
  x: { clientId: string | null; clientSecret: string | null; callbackUrl: string };
  allowedGithubLogins: string[] | null;
  testAuthEnabled: boolean;
  /** OAuth endpoints answered by this server's fixture routes. */
  fixtureOAuth: boolean;
  /** `/api/sync/test/*` is mounted (`SESSION_TEST_ROUTES`). */
  testRoutes: boolean;
  abuse: AbuseLimits;
  sync: SyncConfig;

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
  /** Where the nightly document archive is shipped. Unset disables the
   * in-process backup (`13-deployment-fly.md` §6). */
  documentsReplicaUrl: string | null;
  sentryDsn: string | null;
  metricsToken: string | null;
  /** The 32-byte key that seals stored secrets (`SESSION_SECRET_KEY`): API
   * keys and open account invite codes. Unset, it is
   * `DEVELOPMENT_SECRET_KEY`, but only when `NODE_ENV` is set to
   * `development` or `test`; anything else needs the variable. */
  secretKey: Buffer;
  /** True when `secretKey` is the public development key: boot logs a
   * warning (`main.ts`). */
  secretKeyIsDevelopment: boolean;
  /** True when the cursor key is the public development key: boot logs a
   * warning (`main.ts`). */
  cursorKeyIsDevelopment: boolean;
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

/** The key development and test servers use when `SESSION_SECRET_KEY` is
 * unset. Public by construction: production refuses to start without its
 * own key, so nothing sealed under this one is a deployed secret. */
export const DEVELOPMENT_SECRET_KEY: Buffer = Buffer.alloc(32, 0x5e);

/** The cursor key development and test servers use when
 * `SESSION_CURSOR_KEY` is unset. Production refuses to start without one. */
export const DEVELOPMENT_CURSOR_KEY: Uint8Array = new Uint8Array(32).fill(0xc5);

/** 32 bytes of standard base64: 43 characters and one `=`. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
/** An ISO 8601 time with a date, hours and minutes, and a zone. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** `SESSION_CURSOR_KEY` and its previous key (`01` S3, Y6): 32 bytes of
 * base64 each; the previous one needs the time of the rotation, an ISO time
 * not in the future. In production the cursor key is required and may be
 * neither the development key nor `SESSION_SECRET_KEY`, and the previous key
 * may not be the current one. */
function cursorKeysFrom(
  value: RawEnv,
  options: { required: boolean; production: boolean; secretKey: Buffer; now: number },
): CursorKeys {
  const issues: string[] = [];
  const key = (name: string, raw: string): Uint8Array | null => {
    if (!BASE64_32.test(raw)) {
      issues.push(`${name}: expected 32 bytes of base64 (openssl rand -base64 32)`);
      return null;
    }
    return new Uint8Array(Buffer.from(raw, "base64"));
  };
  let current: Uint8Array | null = DEVELOPMENT_CURSOR_KEY;
  if (value.SESSION_CURSOR_KEY === null) {
    if (options.required)
      issues.push("SESSION_CURSOR_KEY: required unless NODE_ENV is development or test");
  } else current = key("SESSION_CURSOR_KEY", value.SESSION_CURSOR_KEY);
  if (current && options.production) {
    if (sameBytes(current, DEVELOPMENT_CURSOR_KEY))
      issues.push("SESSION_CURSOR_KEY: the public development key is not allowed in production");
    if (sameBytes(current, options.secretKey))
      issues.push("SESSION_CURSOR_KEY: must differ from SESSION_SECRET_KEY");
  }
  let previous: CursorKeys["previous"];
  if (value.SESSION_CURSOR_KEY_PREVIOUS !== null) {
    const old = key("SESSION_CURSOR_KEY_PREVIOUS", value.SESSION_CURSOR_KEY_PREVIOUS);
    const raw = value.SESSION_CURSOR_KEY_ROTATED_AT ?? "";
    const rotatedAt = ISO_TIME.test(raw) ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(rotatedAt))
      issues.push(
        "SESSION_CURSOR_KEY_ROTATED_AT: required with SESSION_CURSOR_KEY_PREVIOUS, as an ISO time (2026-11-01T00:00:00Z)",
      );
    else if (rotatedAt > options.now)
      issues.push("SESSION_CURSOR_KEY_ROTATED_AT: is in the future");
    else if (old) previous = { key: old, rotatedAt };
    if (old && current && options.production && sameBytes(old, current))
      issues.push("SESSION_CURSOR_KEY_PREVIOUS: must differ from SESSION_CURSOR_KEY");
  }
  if (issues.length || current === null) throw new ConfigError(issues);
  return previous ? { current, previous } : { current };
}

/** Whether an origin is this machine's: `localhost`, `127.0.0.0/8` or
 * `[::1]`. */
export function isLoopbackOrigin(origin: string): boolean {
  const host = URL.parse(origin)?.hostname ?? "";
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** `SESSION_SECRET_KEY` as 32 bytes: 64 hex digits, or base64 of 32 bytes.
 * Throws with the reason otherwise. */
export function parseSecretKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  }
  throw new Error("expected 32 bytes as 64 hex digits or base64 (openssl rand -base64 32)");
}

/** `SESSION_SECRET_KEY`, or the development key when the variable is unset
 * and `NODE_ENV` was set to `development` or `test` explicitly. An unset
 * `NODE_ENV` defaults to development for everything else, but not for this:
 * a deploy that forgot both must not seal keys under a public value. */
function secretKeyFrom(value: string | null, nodeEnv: string | undefined): Buffer {
  if (value === null) {
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      throw new ConfigError([
        "SESSION_SECRET_KEY: required unless NODE_ENV is development or test",
      ]);
    }
    return DEVELOPMENT_SECRET_KEY;
  }
  try {
    return parseSecretKey(value);
  } catch (error) {
    throw new ConfigError([`SESSION_SECRET_KEY: ${(error as Error).message}`]);
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
  // Fixture providers answer every model call and the API key check from
  // recordings; a production server must never do that.
  if (fixtureProviders && value.NODE_ENV === "production") {
    throw new ConfigError(["SESSION_FIXTURE_PROVIDERS: not allowed in production"]);
  }
  const nodeEnv = env["NODE_ENV"]?.trim();
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
  const isProduction = value.NODE_ENV === "production";
  if (value.SESSION_MIN_PROTOCOL > PROTOCOL_VERSION) {
    throw new ConfigError([
      `SESSION_MIN_PROTOCOL: ${value.SESSION_MIN_PROTOCOL} is above this build's protocol ${PROTOCOL_VERSION}`,
    ]);
  }
  const secretKey = secretKeyFrom(value.SESSION_SECRET_KEY, nodeEnv);
  const cursorKeys = cursorKeysFrom(value, {
    required: nodeEnv !== "development" && nodeEnv !== "test",
    production: isProduction,
    secretKey,
    now: Date.now(),
  });
  if (isProduction && value.SESSION_FIXTURE_OAUTH) {
    throw new ConfigError(["SESSION_FIXTURE_OAUTH: not allowed in production"]);
  }
  if (
    value.SESSION_TEST_ROUTES &&
    (value.NODE_ENV !== "test" || !isLoopbackOrigin(value.SESSION_PUBLIC_ORIGIN))
  ) {
    throw new ConfigError([
      "SESSION_TEST_ROUTES: allowed only with NODE_ENV=test and a loopback SESSION_PUBLIC_ORIGIN",
    ]);
  }
  return {
    env: value.NODE_ENV,
    isProduction,
    host: value.HOST,
    port: value.PORT,

    publicOrigin: value.SESSION_PUBLIC_ORIGIN,

    dataDir,
    databasePath: join(dataDir, "session.db"),
    documentsDir: join(dataDir, "documents"),
    tmpDir: join(dataDir, "tmp"),

    github: {
      clientId: value.GITHUB_CLIENT_ID,
      clientSecret: value.GITHUB_CLIENT_SECRET,
      callbackUrl: `${value.SESSION_PUBLIC_ORIGIN}/auth/github/callback`,
    },
    x: {
      clientId: value.SESSION_X_CLIENT_ID,
      clientSecret: value.SESSION_X_CLIENT_SECRET,
      callbackUrl: `${value.SESSION_PUBLIC_ORIGIN}/auth/x/callback`,
    },
    allowedGithubLogins: splitLogins(value.SESSION_ALLOWED_GITHUB_LOGINS),
    // Never in production, whatever the variable says (`03-api-and-events.md` §5).
    testAuthEnabled: value.SESSION_TEST_AUTH && !isProduction,
    fixtureOAuth: value.SESSION_FIXTURE_OAUTH && !isProduction,
    testRoutes: value.SESSION_TEST_ROUTES,
    abuse: {
      writesPerMinute: value.SESSION_LIMIT_WRITES_PER_MINUTE,
      snapshotsPerMinute: value.SESSION_LIMIT_SNAPSHOTS_PER_MINUTE,
      authPerMinute: value.SESSION_LIMIT_AUTH_PER_MINUTE,
      failedChecksPerHour: value.SESSION_LIMIT_FAILED_CHECKS_PER_HOUR,
      waitingPerIpPerDay: value.SESSION_LIMIT_WAITING_PER_IP_PER_DAY,
      invitesPerMember: value.SESSION_INVITES_PER_MEMBER,
      invitesPerDay: value.SESSION_LIMIT_INVITES_PER_DAY,
      inviteReadsPerMinute: value.SESSION_LIMIT_INVITE_READS_PER_MINUTE,
      handleChecksPerMinute: value.SESSION_LIMIT_HANDLE_CHECKS_PER_MINUTE,
      spacesPerDay: value.SESSION_LIMIT_SPACES_PER_DAY,
      channelInvitesPerDay: value.SESSION_LIMIT_CHANNEL_INVITES_PER_DAY,
      joinsPerHour: value.SESSION_LIMIT_JOINS_PER_HOUR,
      directoryPerMinute: value.SESSION_LIMIT_DIRECTORY_PER_MINUTE,
      adminPerMinute: value.SESSION_LIMIT_ADMIN_PER_MINUTE,
      registerPerMinute: value.SESSION_LIMIT_REGISTER_PER_MINUTE,
      streamsPerUser: value.SESSION_LIMIT_STREAMS_PER_USER,
      streamOpensPerMinute: value.SESSION_LIMIT_STREAM_OPENS_PER_MINUTE,
      threadReadsPerMinute: value.SESSION_LIMIT_THREAD_READS_PER_MINUTE,
      threadReadsPerIpPerMinute: value.SESSION_LIMIT_THREAD_READS_PER_IP_PER_MINUTE,
      byNamePerMinute: value.SESSION_LIMIT_BY_NAME_PER_MINUTE,
      applyBytes: value.SESSION_LIMIT_APPLY_BYTES,
      applyBatch: value.SESSION_LIMIT_APPLY_BATCH,
    },
    sync: {
      minProtocol: value.SESSION_MIN_PROTOCOL,
      protocol: PROTOCOL_VERSION,
      cursorKeys,
      window: {
        days: value.SESSION_WEB_WINDOW_DAYS,
        threads: value.SESSION_WEB_WINDOW_THREADS,
        cap: value.SESSION_WEB_WINDOW_CAP,
        summaryDays: value.SESSION_WEB_SUMMARY_DAYS,
      },
    },

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
      openai: false,
    },

    search: {
      parallelApiKey: value.PARALLEL_API_KEY,
      tavilyApiKey: value.TAVILY_API_KEY,
      vendor: value.SESSION_SEARCH_VENDOR,
    },

    limits: {
      perUser: value.SESSION_RUNS_PER_USER,
      queuedPerUser: value.SESSION_QUEUED_PER_USER,
      vertex: value.SESSION_RUNS_GEMINI,
      openrouter: value.SESSION_RUNS_OPENROUTER,
      anthropic: value.SESSION_RUNS_ANTHROPIC,
      runTimeoutMs: value.SESSION_RUN_TIMEOUT_SECONDS * 1000,
      weeklyTokens: value.SESSION_WEEKLY_TOKENS,
      overdraftTokens: value.SESSION_OVERDRAFT_TOKENS,
      runMaxTokens: value.SESSION_RUN_MAX_TOKENS,
    },

    litestreamReplicaUrl: value.LITESTREAM_REPLICA_URL,
    documentsReplicaUrl: value.SESSION_DOCUMENTS_REPLICA_URL,
    sentryDsn: value.SENTRY_DSN,
    metricsToken: value.SESSION_METRICS_TOKEN,
    secretKey,
    secretKeyIsDevelopment: value.SESSION_SECRET_KEY === null,
    cursorKeyIsDevelopment: sameBytes(cursorKeys.current, DEVELOPMENT_CURSOR_KEY),
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
