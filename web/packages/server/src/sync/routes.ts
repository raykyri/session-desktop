// The sync routes (`01` §6, A1, S1, Y3-Y7, A3), mounted at `/api/sync`:
//
//   POST /register   { clientId? }                     a new client id, or the tab's re-attached
//   POST /apply      { envelopes: Envelope[] }          answers in order
//   POST /snapshot   { log, tier?, threads?, clientId? } records now, scope-filtered
//   GET  /pull       ?log&cursor&clientId               changes since a cursor
//   POST /read       { reads: [{ log, cursor? | tier?, threads? }], clientId? }
//                                                       snapshots and pulls of several logs
//   GET  /events     ?clientId                          the event stream (SSE read with fetch)
//
// Before these, in `app.ts`: the request id, the protocol check
// (`Session-Protocol`, 426), the session cookie and the CSRF rules. The
// person is the session's: a signed-out caller and a `waiting` account read
// the public path (`01` R5) and write nothing; `/register`, `/apply` and
// `/events` answer them 401 or 403 before reading the body.
//
// The limits of A3 and `04` Z1 are taken here, after the route matched, so
// no spelling of a path passes them: `apply` and tRPC mutations share the
// writes bucket; `snapshot`, `pull` and `read` the snapshots bucket, per
// user or per IP signed out (a `read` of n non-`threads` reads costs
// 1 + floor(n / 10)); a `read` of `threads` reads only the thread-reads
// bucket; `register` and opening a stream a bucket each, per user. Every
// 429 answers `{ code: "TOO_MANY_REQUESTS", message, serverTime }` with
// `Retry-After` in seconds; `apply` answers the envelopes past the budget
// TOO_MANY_REQUESTS in place, unrecorded, when the budget admits some.
//
// A body is read with a running byte count and abandoned past its limit,
// whether or not it declares a length. Any body that is not a JSON object
// answers 400.

import { Refusal, type LogId } from "@session/mutators";
import { type Actor, type ApplyResult, type Tier } from "@session/sync/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";
import type { BucketSpec, RateLimiter } from "../middleware/rateLimit.js";
import { abuseBuckets, writesKey } from "../middleware/rateLimit.js";

import { cursorMapFrom, MAX_EVENT_ID, MAX_STREAM_LOGS, type CursorMap } from "./eventIds.js";
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

class BodyTooLarge extends Error {}
class BadBody extends Error {}

/** The request body as JSON, read with a running byte count: past
 * `maxBytes` the read is cancelled and the request answers 413, whether the
 * body declared its length or came in chunks. An empty body is `{}`; a body
 * that is not a JSON object answers 400. */
async function objectBody(c: Context<AppEnv>, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  const stream = c.req.raw.body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new BadBody("The body is not JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new BadBody("The body is not a JSON object.");
  return parsed as Record<string, unknown>;
}

/** Small request bodies: register, snapshot (500 thread ids). */
const SMALL_BODY = 64 * 1024;
/** `POST /read`: at most this many reads, in at most this many bytes. */
export const MAX_READS = 100;
const READ_BODY = 512 * 1024;
/** A `POST /read` of `threads` reads only: at most this many logs, and this
 * many thread ids across its reads. */
export const MAX_THREAD_READ_LOGS = 20;
export const MAX_THREAD_READ_IDS = 100;
/** The work one `POST /read` may do: this many bytes of answers, or this
 * many ms reading, whichever comes first. The reads past it answer
 * TOO_MANY_REQUESTS in their place. */
export const READ_BUDGET_BYTES = 4 * 1024 * 1024;
export const READ_BUDGET_MS = 250;
/** A `POST /read` costs one snapshot, and one more per this many reads that
 * are not `threads` reads. */
export const READS_PER_SNAPSHOT = 10;

/** A refused read in its place. */
const readError = (code: "BAD_REQUEST" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR") => ({
  error: { code, message: refusal.message(code) },
});

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

  /** The limit key of the caller: the account, or the IP key signed out. */
  const keyOf = (c: Context<AppEnv>, scope: string) => {
    const user = c.get("user");
    return user ? `${scope}:user:${user.id}` : `${scope}:ip:${c.get("ipKey")}`;
  };
  /** Take `cost` tokens, or the 429 that refuses the request. */
  const take = (
    c: Context<AppEnv>,
    key: string,
    spec: BucketSpec,
    cost = 1,
    message?: string,
  ): Response | null => {
    const r = limiter.take(key, spec, cost);
    return r.allowed
      ? null
      : refusal(c, 429, "TOO_MANY_REQUESTS", message, now(), Math.max(1, r.retryAfter));
  };
  const snapshots = (c: Context<AppEnv>, cost = 1) =>
    take(c, keyOf(c, "snapshots"), buckets.snapshots, cost);

  app.onError((error, c) => {
    if (error instanceof BodyTooLarge)
      return refusal(c, 413, "TOO_LARGE", "The request body is too large.", now());
    if (error instanceof BadBody) return refusal(c, 400, "BAD_REQUEST", error.message, now());
    c.get("logger").error({ err: error }, "sync route failed");
    return refusal(c, 500, "INTERNAL_SERVER_ERROR", undefined, now());
  });

  // ---- register (Y3) ----
  app.post("/register", async (c) => {
    const caller = callerOf(c);
    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());
    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());
    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());
    const limited = take(c, `register:user:${c.get("user")?.id ?? ""}`, registerBucket);
    if (limited) return limited;
    const body = await objectBody(c, SMALL_BODY);
    const clientId = typeof body["clientId"] === "string" ? body["clientId"] : undefined;
    const r = sync.server.register(caller.actor, clientId === undefined ? {} : { clientId });
    if (r.ok) return c.json(r, 200);
    // the 50 new ids a day (`01` Y3): a refusal of the request, an hour on
    if (r.error.code === "TOO_MANY_REQUESTS")
      return refusal(c, 429, "TOO_MANY_REQUESTS", r.error.message, now(), 3600);
    const status = r.error.code === "WRONG_CLIENT" ? 409 : r.error.code === "FORBIDDEN" ? 403 : 500;
    return c.json(r, status);
  });

  // ---- apply (Y4), with the writes limit counted per envelope (A3) ----
  app.post("/apply", async (c) => {
    // the caller first: a signed-out or waiting caller's body is not read
    const caller = callerOf(c);
    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());
    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());
    const body = await objectBody(c, limits.applyBytes);
    const envelopes = body["envelopes"];
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
    if (sync.draining)
      return c.json({ answers: envelopes.map(() => unrecorded("SERVICE_UNAVAILABLE")) }, 503);
    // a batch of n counts n writes, in the bucket tRPC mutations take from
    // too (`04` Z1); the envelopes past what the bucket holds answer
    // TOO_MANY_REQUESTS, so the ones before them keep their order
    const key = writesKey(c.get("user")?.id ?? "");
    let admitted = envelopes.length;
    while (admitted > 0 && !limiter.has(key, buckets.writes, admitted)) admitted -= 1;
    if (admitted === 0)
      return (
        take(c, key, buckets.writes) ?? refusal(c, 429, "TOO_MANY_REQUESTS", undefined, now(), 1)
      );
    limiter.take(key, buckets.writes, admitted);
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
      sync.beforeApply(e);
      answers.push(sync.server.apply(caller.actor, e));
      sync.afterApply(e);
    }
    return c.json({ answers }, 200);
  });

  // ---- snapshot and pull (Y5, R5) ----
  app.post("/snapshot", async (c) => {
    const limited = snapshots(c);
    if (limited) return limited;
    const body = await objectBody(c, SMALL_BODY);
    if (typeof body["log"] !== "string")
      return refusal(c, 400, "BAD_REQUEST", "Expected { log }.", now());
    // the server half refuses a tier or a thread list the protocol does not
    // have (BAD_REQUEST, nothing recorded): 400
    let snap;
    try {
      snap = sync.server.snapshot(readerOf(callerOf(c)), body["log"] as LogId, {
        ...(body["tier"] !== undefined ? { tier: body["tier"] as Tier } : {}),
        ...(body["threads"] !== undefined ? { threads: body["threads"] as string[] } : {}),
        ...(typeof body["clientId"] === "string" ? { clientId: body["clientId"] } : {}),
      });
    } catch (e) {
      if (e instanceof Refusal)
        return c.json({ ...e.toError(), serverTime: now() }, e.code === "BAD_REQUEST" ? 400 : 500);
      throw e;
    }
    return c.json(snap, 200);
  });

  app.get("/pull", (c) => {
    const limited = snapshots(c);
    if (limited) return limited;
    const log = c.req.query("log");
    const cursor = c.req.query("cursor") ?? "";
    const clientId = c.req.query("clientId");
    if (log === undefined) return refusal(c, 400, "BAD_REQUEST", "Expected ?log.", now());
    const p = sync.server.pull(readerOf(callerOf(c)), log as LogId, cursor, {
      ...(clientId ? { clientId } : {}),
    });
    return c.json(p, 200);
  });

  // ---- several snapshots and pulls in one request (R5) ----
  // A reader of many channels (a signed-out Home reads every open one) asks
  // for their logs in one request. Each read runs as its own `snapshot` or
  // `pull` under the caller's scope: a read with a `cursor` is a pull, one
  // without is a snapshot. A log is named once. A read the server half
  // refuses answers its error in its place, as does a read that fails (it is
  // logged) and every read past the request's work budget. The reads yield
  // to the event loop between them.
  app.post("/read", async (c) => {
    const body = await objectBody(c, READ_BODY);
    const reads = body["reads"];
    if (!Array.isArray(reads) || reads.length === 0 || reads.length > MAX_READS)
      return refusal(
        c,
        400,
        "BAD_REQUEST",
        `Expected { reads } with 1 to ${MAX_READS} reads.`,
        now(),
      );
    type Read = { log?: unknown; cursor?: unknown; tier?: unknown; threads?: unknown };
    const logs = new Set<string>();
    let threadIds = 0;
    let others = 0;
    for (const read of reads as unknown[]) {
      if (read === null || typeof read !== "object" || Array.isArray(read))
        return refusal(c, 400, "BAD_REQUEST", "Each read is an object.", now());
      const r = read as Read;
      if (r.cursor !== undefined && typeof r.cursor !== "string")
        return refusal(c, 400, "BAD_REQUEST", "A read's cursor is a string.", now());
      if (typeof r.log === "string") {
        if (logs.has(r.log))
          return refusal(c, 400, "BAD_REQUEST", "A read request names each log once.", now());
        logs.add(r.log);
      }
      if (r.tier === "threads" && r.cursor === undefined)
        threadIds += Array.isArray(r.threads) ? r.threads.length : 0;
      else others += 1;
    }
    const threadsOnly = others === 0;
    if (threadsOnly && (reads.length > MAX_THREAD_READ_LOGS || threadIds > MAX_THREAD_READ_IDS))
      return refusal(
        c,
        400,
        "BAD_REQUEST",
        `A read of threads names at most ${MAX_THREAD_READ_LOGS} logs and ${MAX_THREAD_READ_IDS} thread ids.`,
        now(),
      );
    const limited = threadsOnly
      ? take(
          c,
          keyOf(c, "threadReads"),
          c.get("user") ? buckets.threadReads : buckets.threadReadsSignedOut,
        )
      : snapshots(c, 1 + Math.floor(others / READS_PER_SNAPSHOT));
    if (limited) return limited;
    const reader = readerOf(callerOf(c));
    const clientId = typeof body["clientId"] === "string" ? body["clientId"] : undefined;
    const one = (r: Read): unknown => {
      if (typeof r.log !== "string") return readError("BAD_REQUEST");
      try {
        if (typeof r.cursor === "string")
          return sync.server.pull(reader, r.log as LogId, r.cursor, {
            ...(clientId ? { clientId } : {}),
          });
        return sync.server.snapshot(reader, r.log as LogId, {
          ...(r.tier !== undefined ? { tier: r.tier as Tier } : {}),
          ...(r.threads !== undefined ? { threads: r.threads as string[] } : {}),
          ...(clientId ? { clientId } : {}),
        });
      } catch (e) {
        if (e instanceof Refusal && e.code === "BAD_REQUEST") return { error: e.toError() };
        c.get("logger").error({ err: e, log: r.log }, "sync read failed");
        return readError("INTERNAL_SERVER_ERROR");
      }
    };
    const answers: string[] = [];
    let bytes = 0;
    let spent = 0;
    for (const read of reads as Read[]) {
      if (bytes >= READ_BUDGET_BYTES || spent >= READ_BUDGET_MS) {
        answers.push(JSON.stringify(readError("TOO_MANY_REQUESTS")));
        continue;
      }
      if (answers.length > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const started = performance.now();
      const text = JSON.stringify(one(read));
      spent += performance.now() - started;
      bytes += Buffer.byteLength(text);
      answers.push(text);
    }
    return c.body(`{"answers":[${answers.join(",")}],"serverTime":${String(now())}}`, 200, {
      "Content-Type": "application/json",
    });
  });

  // ---- the event stream (Y7) ----
  app.get("/events", (c) => {
    const caller = callerOf(c);
    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());
    // the stream needs a registered client id; a waiting reader pulls (R5)
    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());
    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());
    const limited = take(c, `streamOpens:user:${c.get("user")?.id ?? ""}`, buckets.streamOpens);
    if (limited) return limited;
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
    const scope = { u, history: sync.store.history() };
    if (last) for (const [log, cur] of sync.hub.ids.open(last, scope) ?? []) cursors.set(log, cur);
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
    if (cursors.size > MAX_STREAM_LOGS)
      return refusal(
        c,
        400,
        "BAD_REQUEST",
        `A stream reads at most ${MAX_STREAM_LOGS} logs, Last-Event-ID and Session-Cursors together.`,
        now(),
      );
    const token = c.get("sessionToken");
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const queue: StreamEvent[] = [];
      let queuedBytes = 0;
      let done = false;
      let wake: (() => void) | null = null;
      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const end = () => {
        done = true;
        queue.length = 0;
        queuedBytes = 0;
        poke();
      };
      const s = sync.hub.open({
        u,
        clientId,
        sessionToken: token,
        cursors,
        sink: {
          send: (e) => {
            queue.push(e);
            queuedBytes += e.data.length + (e.id?.length ?? 0);
            poke();
          },
          queued: () => queue.length,
          queuedBytes: () => queuedBytes,
          // the hub ended the stream: a write blocked on the socket is
          // released by the abort, and the response ends
          close: () => {
            end();
            stream.abort();
          },
        },
      });
      stream.onAbort(end);
      try {
        while (!done) {
          const e = queue.shift();
          if (e) {
            queuedBytes -= e.data.length + (e.id?.length ?? 0);
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
