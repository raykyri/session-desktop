// The sync routes (`01` §6, A1, S1, Y3-Y7, A3), mounted at `/api/sync`:
//
//   POST /register   { clientId? }                     a new client id, or the tab's re-attached
//   POST /apply      { envelopes: Envelope[] }          answers in order
//   POST /snapshot   { log, tier?, threads?, clientId? } records now, scope-filtered
//   GET  /pull       ?log&cursor&clientId               changes since a cursor
//   GET  /events     ?clientId                          the event stream (SSE read with fetch)
//
// Before these, in `app.ts`: the request id, the protocol check
// (`Session-Protocol`, 426), the session cookie, the CSRF rules and the
// snapshot limit. The person is the session's: a signed-out caller and a
// `waiting` account read the public path (`01` R5) and write nothing. The
// limits of A3 answer TOO_MANY_REQUESTS, unrecorded.

import type { LogId } from "@session/mutators";
import { type Actor, type ApplyResult, type RegisterResult, type Tier } from "@session/sync/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";
import type { RateLimiter } from "../middleware/rateLimit.js";
import { abuseBuckets } from "../middleware/rateLimit.js";

import { cursorMapFrom, MAX_EVENT_ID, type CursorMap } from "./eventIds.js";
import type { StreamEvent } from "./hub.js";
import { refusal } from "./protocol.js";
import type { SyncService } from "./service.js";

const MINUTE = 60_000;

/** Who a request is for: a signed-in person who may write, a person who may
 * only read the public path (`waiting`), or nobody. */
type Caller = { kind: "member"; actor: Actor } | { kind: "waiting" } | { kind: "none" };

function callerOf(c: Context<AppEnv>): Caller {
  const user = c.get("user");
  if (!user) return { kind: "none" };
  if (user.status !== "active" || user.handle === null) return { kind: "waiting" };
  return { kind: "member", actor: { u: user.handle } };
}

/** The reading actor: a waiting account reads as signed out. */
const readerOf = (caller: Caller): Actor | null => (caller.kind === "member" ? caller.actor : null);

const STATUS: Partial<Record<string, 400 | 401 | 403 | 409 | 429 | 500 | 503>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  WRONG_CLIENT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

async function jsonBody(c: Context<AppEnv>, maxBytes: number): Promise<unknown> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new BodyTooLarge();
  if (buf.byteLength === 0) return {};
  try {
    return JSON.parse(Buffer.from(buf).toString("utf8")) as unknown;
  } catch {
    throw new BadJson();
  }
}

class BodyTooLarge extends Error {}
class BadJson extends Error {}

/** Small request bodies: register, snapshot (500 thread ids). */
const SMALL_BODY = 64 * 1024;

export interface SyncRoutesOptions {
  sync: SyncService;
  config: Config;
  limiter: RateLimiter;
}

export function syncRoutes(options: SyncRoutesOptions): Hono<AppEnv> {
  const { sync, config, limiter } = options;
  const limits = config.abuse;
  const buckets = abuseBuckets(limits);
  const registerBucket = { limit: limits.registerPerMinute, windowMs: MINUTE };
  const idleTtl = sync.clientIdleTtl;
  const app = new Hono<AppEnv>();
  const now = () => sync.clock.now();

  app.onError((error, c) => {
    if (error instanceof BodyTooLarge)
      return refusal(c, 413, "TOO_LARGE", "The request body is too large.", now());
    if (error instanceof BadJson)
      return refusal(c, 400, "BAD_REQUEST", "The body is not JSON.", now());
    c.get("logger").error({ err: error }, "sync route failed");
    return refusal(c, 500, "INTERNAL_SERVER_ERROR", undefined, now());
  });

  // ---- register (Y3) ----
  app.post("/register", async (c) => {
    const caller = callerOf(c);
    // a signed-out caller gets the server half's own answer (UNAUTHORIZED)
    if (caller.kind === "none") return c.json(sync.server.register(null), 401);
    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());
    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());
    const limited = limiter.take(`register:user:${c.get("user")?.id ?? ""}`, registerBucket);
    if (!limited.allowed)
      return refusal(c, 429, "TOO_MANY_REQUESTS", undefined, now(), limited.retryAfter);
    const body = (await jsonBody(c, SMALL_BODY)) as { clientId?: unknown };
    const clientId = typeof body.clientId === "string" ? body.clientId : undefined;
    const r: RegisterResult = sync.server.register(
      caller.actor,
      clientId === undefined ? {} : { clientId },
    );
    return c.json(r, r.ok ? 200 : (STATUS[r.error.code] ?? 400));
  });

  // ---- apply (Y4), with the writes limit counted per envelope (A3) ----
  app.post("/apply", async (c) => {
    const caller = callerOf(c);
    const body = (await jsonBody(c, limits.applyBytes)) as { envelopes?: unknown };
    const envelopes = body.envelopes;
    if (!Array.isArray(envelopes) || envelopes.length === 0 || envelopes.length > limits.applyBatch)
      return refusal(
        c,
        400,
        "BAD_REQUEST",
        `Expected { envelopes } with 1 to ${limits.applyBatch} envelopes.`,
        now(),
      );
    const unrecorded = (code: "SERVICE_UNAVAILABLE" | "TOO_MANY_REQUESTS"): ApplyResult => ({
      ok: false,
      error: { code, message: refusal.message(code), serverTime: now() },
    });
    // a signed-out caller gets the server half's answers: each envelope's
    // shape is checked before the sign-in, as in-process (UNAUTHORIZED
    // otherwise); a waiting account may not write
    if (caller.kind === "none")
      return c.json({ answers: envelopes.map((e) => sync.server.apply(null, e)) }, 401);
    if (caller.kind === "waiting")
      return c.json(
        {
          answers: envelopes.map((): ApplyResult => ({
            ok: false,
            error: { code: "FORBIDDEN", message: refusal.message("FORBIDDEN"), serverTime: now() },
          })),
        },
        403,
      );
    if (sync.draining)
      return c.json({ answers: envelopes.map(() => unrecorded("SERVICE_UNAVAILABLE")) }, 503);
    // a batch of n counts n writes; the envelopes past what the bucket holds
    // answer TOO_MANY_REQUESTS, so the ones before them keep their order
    const key = `writes:user:${c.get("user")?.id ?? ""}`;
    let admitted = envelopes.length;
    while (admitted > 0 && !limiter.has(key, buckets.writes, admitted)) admitted -= 1;
    const taken =
      admitted > 0
        ? limiter.take(key, buckets.writes, admitted)
        : limiter.take(key, buckets.writes, 1);
    const answers: ApplyResult[] = [];
    for (const [i, e] of envelopes.entries()) {
      if (i >= admitted) {
        answers.push(unrecorded("TOO_MANY_REQUESTS"));
        continue;
      }
      // the drain may begin while a batch is answered
      if (sync.draining) {
        answers.push(unrecorded("SERVICE_UNAVAILABLE"));
        continue;
      }
      answers.push(sync.server.apply(caller.actor, e));
      sync.afterApply(e);
    }
    if (admitted === 0) {
      c.header("Retry-After", String(Math.max(1, taken.retryAfter)));
      return c.json({ answers }, 429);
    }
    return c.json({ answers }, 200);
  });

  // ---- snapshot and pull (Y5, R5) ----
  app.post("/snapshot", async (c) => {
    const body = (await jsonBody(c, SMALL_BODY)) as {
      log?: unknown;
      tier?: unknown;
      threads?: unknown;
      clientId?: unknown;
    };
    if (typeof body.log !== "string")
      return refusal(c, 400, "BAD_REQUEST", "Expected { log }.", now());
    const tier = (["full", "summary", "window", "threads"] as const).find((x) => x === body.tier);
    if (body.tier !== undefined && tier === undefined)
      return refusal(c, 400, "BAD_REQUEST", "Unknown tier.", now());
    const threads =
      Array.isArray(body.threads) && body.threads.every((x) => typeof x === "string")
        ? body.threads
        : undefined;
    const snap = sync.server.snapshot(readerOf(callerOf(c)), body.log as LogId, {
      ...(tier ? { tier: tier satisfies Tier } : {}),
      ...(threads ? { threads } : {}),
      ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
    });
    return c.json(snap, 200);
  });

  app.get("/pull", (c) => {
    const log = c.req.query("log");
    const cursor = c.req.query("cursor") ?? "";
    const clientId = c.req.query("clientId");
    if (log === undefined) return refusal(c, 400, "BAD_REQUEST", "Expected ?log.", now());
    const p = sync.server.pull(readerOf(callerOf(c)), log as LogId, cursor, {
      ...(clientId ? { clientId } : {}),
    });
    return c.json(p, 200);
  });

  // ---- the event stream (Y7) ----
  app.get("/events", (c) => {
    const caller = callerOf(c);
    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());
    // the stream needs a registered client id; a waiting reader pulls (R5)
    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());
    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());
    const u = caller.actor.u;
    const clientId = c.req.query("clientId") ?? "";
    const client = sync.store.client(clientId);
    if (!client || client.u !== u || client.seen <= now() - idleTtl)
      return refusal(c, 409, "WRONG_CLIENT", undefined, now());
    // one stream per client id (a new one replaces it); a few per person
    const replacing = sync.hub.has(clientId);
    if (!replacing && sync.hub.streamsOf(u) >= limits.streamsPerUser)
      return refusal(c, 429, "TOO_MANY_REQUESTS", "Too many open streams.", now(), 60);
    const cursors: CursorMap = new Map();
    const last = c.req.header("last-event-id");
    if (last) for (const [log, cur] of sync.hub.ids.open(last) ?? []) cursors.set(log, cur);
    const named = c.req.header("session-cursors");
    if (named) {
      let parsed: unknown = null;
      try {
        parsed = named.length <= MAX_EVENT_ID ? (JSON.parse(named) as unknown) : null;
      } catch {
        parsed = null;
      }
      const map = cursorMapFrom(parsed);
      if (!map)
        return refusal(c, 400, "BAD_REQUEST", "Session-Cursors is not a map of cursors.", now());
      for (const [log, cur] of map) cursors.set(log, cur);
    }
    if (cursors.size === 0)
      return refusal(
        c,
        400,
        "BAD_REQUEST",
        "Name the logs to read: Session-Cursors or Last-Event-ID.",
        now(),
      );
    const token = c.get("sessionToken");
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const queue: StreamEvent[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const s = sync.hub.open({
        u,
        clientId,
        sessionToken: token,
        cursors,
        sink: {
          send: (e) => {
            queue.push(e);
            poke();
          },
          queued: () => queue.length,
          close: () => {
            done = true;
            poke();
          },
        },
      });
      stream.onAbort(() => {
        done = true;
        poke();
      });
      try {
        while (!done) {
          const e = queue.shift();
          if (e) {
            await stream.writeSSE(e.id === undefined ? { event: e.event, data: e.data } : e);
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        sync.hub.remove(s);
      }
    });
  });

  return app;
}
