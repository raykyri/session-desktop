// The sync protocol over HTTP (phase 2a), at the mock's paths and the 1b
// client transport's (`@session/sync/client`'s `FetchTransport`):
//   POST /api/sync/register   a client id for the caller (and device)
//   POST /api/sync/write      one write envelope; the body's size goes to
//                              `apply` (TOO_LARGE)
//   POST /api/sync/snapshot   { log, clientId?, tier?, threads? }
//   POST /api/sync/pull       { log, cursor, clientId?, tier? }
//   GET  /api/sync/events     SSE (cursor tokens in Last-Event-ID or ?cursors);
//                              at most SESSION_STREAMS_PER_READER open per
//                              session, device or signed-out address (429)
//   POST /api/rpc/<name>      an online-only call (`NOT_MUTATORS`)
//   GET  /api/rpc/usage.listAsks, and the account reads under /api/me
//   GET  /api/spaces          the spaces the caller may find (the directory)
//   GET  /api/invites/:code   an invite link's landing: its space and state
//   GET  /api/spaces/named/:name  a space by its name (an unlisted one: its name)
//   GET  /api/devices/requests/:request  a device sign-in, for the browser
//                              that approves it (no code)
//   POST /api/admin/reset-time  an operator resets the stored server time
// A route parses the request, authenticates (the session cookie, or a
// device's bearer token: `auth/actor.ts`), checks the protocol header, and
// calls the package; the rules are `@session/sync`'s. Every answer carries
// the server's time, in the body and in `X-Session-Server-Time`.

import { auth } from "@session/db";
import { PROTOCOL_HEADER, type LogId, type ReadOptions } from "@session/sync";
import { addressKey, sseResponse } from "@session/sync/server";
import type { Context } from "hono";
import { Hono } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";

import { apiKeysOf, devicesOf, listAsks, meOf, peopleOf, settingsOf, usageOf } from "./account.js";

/** The HTTP status of an error code (the mock's CODES). */
export const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  STALE: 409,
  EXPIRED: 422,
  TOO_LARGE: 413,
  UPDATE_REQUIRED: 426,
  CLOCK_SKEW: 400,
  OUT_OF_ORDER: 409,
  WRONG_CLIENT: 401,
};

/** The largest request body read (an online call's input is at most 1 MB;
 * a write envelope at most 256 KB, which `apply` checks). */
const MAX_BODY_BYTES = 1024 * 1024 + 4096;

type Answerish = { ok?: boolean; error?: { code: string }; serverTime: number };

/** The caller's network address (`clientIp`, from the trusted proxy header
 * or the socket), or null when not known. */
const ipOf = (c: Context<AppEnv>): string | null => {
  const ip = c.get("clientIp");
  return ip && ip !== "unknown" ? ip : null;
};

function answer(c: Context<AppEnv>, a: Answerish) {
  const status = a.ok === false && a.error ? (STATUS[a.error.code] ?? 400) : 200;
  c.header("X-Session-Server-Time", String(a.serverTime));
  c.header("Cache-Control", "no-store");
  return c.json(a, status as 200);
}

/** The protocol version a request speaks (its header), or undefined. */
function versionOf(c: Context<AppEnv>): number | undefined {
  const h = c.req.header(PROTOCOL_HEADER);
  if (h === undefined) return undefined;
  const n = Number(h);
  return Number.isInteger(n) ? n : 0;
}

/** A JSON body of at most MAX_BODY_BYTES: the value and its size, or null. */
async function body(c: Context<AppEnv>): Promise<{ value: unknown; size: number } | null> {
  const text = await c.req.text();
  const size = Buffer.byteLength(text);
  if (size > MAX_BODY_BYTES) return { value: undefined, size };
  if (text === "") return { value: {}, size: 0 };
  try {
    return { value: JSON.parse(text) as unknown, size };
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The read options a body names, and nothing else. */
function readOptions(b: Record<string, unknown>): ReadOptions {
  const o: ReadOptions = {};
  if (typeof b["clientId"] === "string") o.clientId = b["clientId"];
  if (isObject(b["tier"])) {
    const t = b["tier"];
    const window = t["window"];
    o.tier = {
      ...(window === "desktop" || window === "phone" || window === "full" || window === "summary"
        ? { window }
        : {}),
      ...(Array.isArray(t["opened"])
        ? { opened: t["opened"].filter((x): x is string => typeof x === "string").slice(0, 500) }
        : {}),
    };
  }
  if (Array.isArray(b["threads"]))
    o.threads = b["threads"].filter((x): x is string => typeof x === "string").slice(0, 500);
  return o;
}

export function syncRoutes(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { sync, db } = deps;
  const now = () => sync.clockNow();
  const error = (c: Context<AppEnv>, code: string, message = code) =>
    answer(c, { ok: false, error: { code, message } as never, serverTime: now() });

  // below the configured minimum protocol: UPDATE_REQUIRED (426) before
  // anything else, on every sync and rpc request that names a version
  const guard = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const v = versionOf(c);
    if (v !== undefined && v < sync.minProtocol)
      return error(c, "UPDATE_REQUIRED", "Update Session.");
    await next();
  };
  app.use("/api/sync/*", guard);
  app.use("/api/rpc/*", guard);

  app.post("/api/sync/register", (c) => answer(c, sync.register(c.get("actor"))));

  app.post("/api/sync/write", async (c) => {
    const b = await body(c);
    if (b === null) return error(c, "BAD_REQUEST", "The body is not JSON.");
    return answer(c, sync.apply(c.get("actor"), b.value, b.size));
  });

  app.post("/api/sync/snapshot", async (c) => {
    const b = await body(c);
    if (b === null || !isObject(b.value) || typeof b.value["log"] !== "string")
      return error(c, "BAD_REQUEST", "Expected { log }.");
    const v = versionOf(c);
    return answer(
      c,
      sync.snapshot(c.get("actor"), b.value["log"] as LogId, {
        ...readOptions(b.value),
        ...(v !== undefined ? { protocolVersion: v } : {}),
      }),
    );
  });

  app.post("/api/sync/pull", async (c) => {
    const b = await body(c);
    if (
      b === null ||
      !isObject(b.value) ||
      typeof b.value["log"] !== "string" ||
      typeof b.value["cursor"] !== "string"
    )
      return error(c, "BAD_REQUEST", "Expected { log, cursor }.");
    const v = versionOf(c);
    return answer(
      c,
      sync.pull(c.get("actor"), b.value["log"] as LogId, b.value["cursor"], {
        ...readOptions(b.value),
        ...(v !== undefined ? { protocolVersion: v } : {}),
      }),
    );
  });

  app.get("/api/sync/events", (c) => {
    // a bearer request whose token did not open is refused, not served as
    // signed out
    if (c.get("bearer") && c.get("actor") === null) return error(c, "UNAUTHORIZED");
    const ac = new AbortController();
    const session = c.get("bearer") ? null : c.get("sessionToken");
    const sessionId = session === null ? null : sessionKey(session);
    // what the stream counts against: the device, the browser session, or
    // signed out the client's address (review round 2 of phase 2)
    const actor = c.get("actor");
    const ip = ipOf(c);
    const reader =
      actor?.device != null
        ? `device:${actor.device}`
        : sessionId !== null
          ? `session:${sessionId}`
          : ip !== null
            ? `ip:${addressKey(ip)}`
            : null;
    const done = deps.streams.add(sessionId, ac, reader);
    if (done === null)
      return error(
        c,
        "TOO_MANY_REQUESTS",
        `${deps.streams.perReader} event streams are open for this session, device or address, the most allowed. Close one to open another.`,
      );
    c.req.raw.signal.addEventListener("abort", () => ac.abort());
    ac.signal.addEventListener("abort", done);
    const req = new Request(c.req.url, { headers: c.req.raw.headers, signal: ac.signal });
    const res = sseResponse(sync, req, c.get("actor"));
    res.headers.set("X-Accel-Buffering", "no");
    return res;
  });

  // ---- online calls ----

  app.get("/api/rpc/usage.listAsks", (c) => {
    const user = c.get("user");
    if (!user) return error(c, "UNAUTHORIZED");
    let input: { cursor?: string | null; limit?: number } = {};
    try {
      const raw = c.req.query("input");
      if (raw) input = JSON.parse(raw) as typeof input;
    } catch {
      return error(c, "BAD_REQUEST");
    }
    const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, input.limit)) : 8;
    return c.json(listAsks(db, sync, user, { cursor: input.cursor ?? null, limit }));
  });

  app.post("/api/rpc/:name", async (c) => {
    const b = await body(c);
    if (b === null) return error(c, "BAD_REQUEST", "The body is not JSON.");
    if (b.value === undefined) return error(c, "TOO_LARGE");
    return answer(c, sync.call(c.get("actor"), c.req.param("name"), b.value, { ip: ipOf(c) }));
  });

  // a device's sign-in as the browser that approves it reads it (the
  // /device page): the device, the app, when it was asked and whether from
  // this computer; never the code (review round 1 of phase 2)
  app.get("/api/devices/requests/:request", (c) => {
    if (c.get("bearer"))
      return error(c, "FORBIDDEN", "Approve a device’s sign-in from a browser, not from a device.");
    const v = sync.online.signinView(c.get("actor"), c.req.param("request"), { ip: ipOf(c) });
    if (!v.ok) return answer(c, v);
    c.header("X-Session-Server-Time", String(v.view.serverTime));
    c.header("Cache-Control", "no-store");
    return c.json(v.view);
  });

  // ---- account reads (the mock's /api/me rows that are not replicated) ----

  const signedIn = (c: Context<AppEnv>) => {
    const user = c.get("user");
    return user ?? null;
  };
  app.get("/api/me", (c) => {
    const user = signedIn(c);
    if (!user) return error(c, "UNAUTHORIZED");
    // the mock's fields, and the account's for the web shell (phase 2b: in
    // place of tRPC's auth.me)
    return c.json({
      ...meOf(sync, user),
      id: user.id,
      login: user.login,
      handle: user.handle,
      avatarUrl: user.avatarUrl ?? null,
      isAdmin: user.isAdmin,
    });
  });
  app.get("/api/me/settings", (c) => {
    const user = signedIn(c);
    if (!user) return error(c, "UNAUTHORIZED");
    return c.json(settingsOf(db, user.id));
  });
  app.get("/api/me/usage", (c) => {
    const user = signedIn(c);
    if (!user) return error(c, "UNAUTHORIZED");
    return c.json(usageOf(db, sync, deps.config, user));
  });
  app.get("/api/me/api-keys", (c) => {
    const user = signedIn(c);
    if (!user) return error(c, "UNAUTHORIZED");
    return c.json(apiKeysOf(db, sync, user));
  });
  app.get("/api/me/devices", (c) => {
    const user = signedIn(c);
    if (!user) return error(c, "UNAUTHORIZED");
    return c.json(devicesOf(sync, user.handle));
  });
  app.get("/api/users", (c) => {
    return c.json(peopleOf(db, sync, c.req.queries("handle") ?? []));
  });

  // the spaces the caller may find, and the stats of those they read (the
  // web client's directory: Home, the header, Browse; phase 2b)
  app.get("/api/spaces", (c) => {
    const d = sync.directory(c.get("actor"));
    c.header("X-Session-Server-Time", String(d.serverTime));
    c.header("Cache-Control", "no-store");
    return c.json(d);
  });

  // a space a link names, for a reader the directory does not list it to
  // (an unlisted space they are not in: its name only)
  app.get("/api/spaces/named/:name", (c) => {
    const s = sync.spaceNamed(c.req.param("name"), c.get("actor"));
    if (!s) return error(c, "NOT_FOUND");
    c.header("Cache-Control", "no-store");
    return c.json({ space: s, serverTime: now() });
  });

  // an invite link's landing page (/i/<code>): the space it admits to and
  // whether it still does; signed out too, as the mock's landing is
  app.get("/api/invites/:code", (c) => {
    const code = c.req.param("code");
    if (!/^[0-9A-Za-z]{1,32}$/.test(code)) return error(c, "NOT_FOUND");
    const v = sync.invite(code);
    if (!v) return error(c, "NOT_FOUND");
    c.header("X-Session-Server-Time", String(v.serverTime));
    c.header("Cache-Control", "no-store");
    return c.json(v);
  });

  // ---- operators ----

  // AGENTS.md: server time never goes back; after the machine's clock jumped
  // ahead and was corrected, an operator resets it (admins only, and never
  // with a device token)
  app.post("/api/admin/reset-time", (c) => {
    const user = c.get("user");
    if (!user || c.get("bearer")) return error(c, "UNAUTHORIZED");
    if (!user.isAdmin) return error(c, "FORBIDDEN");
    const serverTime = sync.resetTime();
    c.get("logger").warn({ admin: user.id, serverTime }, "the sync server's time was reset");
    return answer(c, { ok: true, serverTime });
  });

  return app;
}

/** The registry key of a session's streams: the cookie's hash, as the
 * `sessions` table keys it. */
export const sessionKey = (token: string) => auth.hashSessionToken(token);
