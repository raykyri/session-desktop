// The online-only calls: the mock's procedures that change state but are not
// mutators (`NOT_MUTATORS`). They are never queued: the client sends them
// directly, and each runs in one store transaction. This file serves
// `devices.*` (device sign-in, tokens, revocation) and `runs.*` (device run
// leases: 90 s, a heartbeat separate from progress, attempts, the
// `interrupted` and `too_large` ends), with the mock's contract
// (`web/packages/shared/src/schemas/spaces.ts`, the mock's rows). API keys,
// usage, settings and the run controls (`research.cancelNode`, `retryNode`)
// are stubs that answer METHOD_NOT_SUPPORTED until phase 2 gives handlers.
//
// Addition to the mock's contract: `devices.token({ request })`, which the
// app calls after its sign-in was approved to take its token, once.

import { createHash, randomBytes } from "node:crypto";

import * as pkg from "@session/mutators";
import { spaces } from "@session/shared";
import { z } from "zod";

import { HOUR, MINUTE, type Actor, type CallAnswer, type SseEvent } from "../protocol.js";

import type { SyncServer } from "./server.js";
import type { StoreTx } from "./store.js";

/** A device run's lease, and the largest device answer (server settings). */
export const LEASE_MS = 90_000;
export const DEVICE_ANSWER_MAX = 200 * 1024;
/** How long a device sign-in waits for its approval and for the app to take
 * its token. */
export const SIGNIN_TTL = 10 * MINUTE;
/** A device's `seen` is written at most this often. */
export const SEEN_EVERY = HOUR;

export interface CallCtx {
  tx: StoreTx;
  now: number;
  actor: Actor | null;
  server: SyncServer;
}

export type Handler = (ctx: CallCtx, input: unknown) => unknown;

/** Every online-only call, by name. */
export type OnlineHandlers = Record<string, Handler>;

const fail = (code: pkg.ErrorCode, message?: string, issues?: string[]) =>
  pkg.refuse(code, message, issues);

const need = (ctx: CallCtx): Actor => {
  if (!ctx.actor || !pkg.isHandle(ctx.actor.u)) throw fail("UNAUTHORIZED");
  return ctx.actor;
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success)
    throw fail(
      "BAD_REQUEST",
      undefined,
      r.error.issues.map((x) => `input${x.path.map((p) => `.${String(p)}`).join("")}: ${x.code}`),
    );
  return r.data;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

const P = spaces.spaceProcedures;
const runInput = z.strictObject({ run: z.string().max(64), device: z.string().max(64) });

/** A run of the caller's, run by the calling device: for every call but
 * claim, the attempt that holds the lease. */
function leaseOf(ctx: CallCtx, i: { run: string; device: string; attempt?: number }, claim = false) {
  const a = need(ctx);
  if (a.device != null && a.device !== i.device)
    throw fail("FORBIDDEN", "This run runs on another device.");
  const r = ctx.tx.get(`run:${i.run}`);
  if (r?.kind !== "run") throw fail("NOT_FOUND", "The server has no record of this run.");
  if (!r.executor || r.executor.u !== a.u)
    throw fail("FORBIDDEN", "This run isn’t one of your device runs.");
  if (r.executor.device !== i.device) throw fail("FORBIDDEN", "This run runs on another device.");
  if (!claim && (r.status !== "running" || r.attempt !== i.attempt))
    throw fail("PRECONDITION_FAILED", "This attempt no longer holds the run’s lease.");
  return r;
}

const leaseAt = (now: number) => ({ until: pkg.isoAt(now + LEASE_MS), beat: pkg.isoAt(now) });

/** End a device run without an answer: its lease ended, or its answer was
 * too large. The thread (or follow-up) stops running. */
function endRun(ctx: CallCtx, r: pkg.RunRec, why: "interrupted" | "too_large") {
  const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "failed", end: why, lease: null }]];
  const p = ctx.tx.get(`thread:${r.th}`);
  if (r.node === "r" && p?.kind === "thread") writes.push([`thread:${p.id}`, { ...p, running: false }]);
  ctx.tx.leaseDelete(r.id);
  ctx.server.commit(ctx.tx, writes, ctx.now);
}

/** Every turn a run rebuilds its context from (no CLI session resumes). */
function turnsOf(tx: StoreTx, r: pkg.RunRec) {
  const p = tx.get(`thread:${r.th}`);
  if (p?.kind !== "thread") return [];
  const fus = tx
    .scan("followup", "th", p.id)
    .filter((f): f is pkg.FollowUpRec => f.kind === "followup" && f.mod === null && !f.del)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return [{ q: p.q, a: p.sum ?? "" }, ...fus.map((f) => ({ q: f.q, a: f.a ?? "" }))];
}

const stub =
  (name: string): Handler =>
  () => {
    throw fail("METHOD_NOT_SUPPORTED", `${name} is not served yet (phase 2).`);
  };

export function defaultHandlers(): OnlineHandlers {
  const h: OnlineHandlers = {};
  for (const name of Object.keys(pkg.NOT_MUTATORS)) h[name] = stub(name);

  h["devices.authorize"] = (ctx, input) => {
    const i = parse(P["devices.authorize"].input.strict(), input);
    const name = i.name.trim();
    if (!name) throw fail("BAD_REQUEST", undefined, ["input.name: expected some text"]);
    const request = ctx.server.newId(ctx.tx, ctx.now);
    let code = "";
    for (let k = 0; k < 6; k++) code += CODE.charAt(Math.floor(ctx.server.randomNumber() * CODE.length));
    ctx.tx.signinPut({
      request,
      code,
      name,
      kind: i.kind ?? "mac",
      at: ctx.now,
      state: "waiting",
      u: null,
      device: null,
      token: null,
    });
    return { request, code: `${code.slice(0, 3)}-${code.slice(3)}`, url: "session.app/device" };
  };

  h["devices.approve"] = (ctx, input) => {
    const a = need(ctx);
    const i = parse(P["devices.approve"].input.strict(), input);
    const s = ctx.tx.signinGet(i.request);
    if (!s || s.state !== "waiting" || s.at < ctx.now - SIGNIN_TTL)
      throw fail("NOT_FOUND", "The server has no record of this sign-in. It may have expired.");
    if (i.code !== undefined && i.code.replace(/[^A-Z0-9]/gi, "").toUpperCase() !== s.code)
      throw fail("BAD_REQUEST", "This code doesn’t match the one on your Mac.", [
        "input.code: expected the code the app shows",
      ]);
    if (i.deny) {
      ctx.tx.signinPut({ ...s, state: "denied" });
      return { device: null };
    }
    const id = ctx.server.newId(ctx.tx, ctx.now);
    const token = randomBytes(32).toString("base64url");
    ctx.tx.tokenPut({ device: id, u: a.u, hash: sha256(token), revokedAt: null });
    ctx.server.commit(
      ctx.tx,
      [
        [
          `device:${id}`,
          {
            kind: "device",
            id,
            u: a.u,
            name: s.name,
            type: s.kind,
            plat: s.kind === "mac" ? "macOS" : "iOS",
            createdAt: pkg.isoAt(ctx.now),
            seen: pkg.isoAt(ctx.now),
          },
        ],
      ],
      ctx.now,
    );
    ctx.tx.signinPut({ ...s, state: "approved", u: a.u, device: id, token });
    return { device: id };
  };

  h["devices.token"] = (ctx, input) => {
    const i = parse(z.strictObject({ request: z.string().max(64) }), input);
    const s = ctx.tx.signinGet(i.request);
    if (!s || s.at < ctx.now - SIGNIN_TTL || s.state === "taken")
      throw fail("NOT_FOUND", "The server has no record of this sign-in. It may have expired.");
    if (s.state === "denied") throw fail("FORBIDDEN", "The sign-in was denied.");
    if (s.state !== "approved" || s.token === null)
      throw fail("PRECONDITION_FAILED", "The sign-in is waiting for its approval.");
    ctx.tx.signinPut({ ...s, state: "taken", token: null });
    return { token: s.token, device: s.device, u: s.u };
  };

  h["devices.revoke"] = (ctx, input) => {
    const a = need(ctx);
    const i = parse(P["devices.revoke"].input.strict(), input);
    const d = ctx.tx.get(`device:${i.id}`);
    if (d?.kind !== "device" || d.u !== a.u)
      throw fail("NOT_FOUND", "The server has no record of this device.");
    const t = ctx.tx.tokenGet(d.id);
    if (t) ctx.tx.tokenPut({ ...t, revokedAt: ctx.now });
    // its unsent writes are refused: its clients are gone (WRONG_CLIENT)
    for (const c of ctx.tx.clientsOfDevice(d.id)) ctx.tx.clientDelete(c);
    ctx.server.commit(ctx.tx, [[`device:${d.id}`, null]], ctx.now);
    return null;
  };

  h["runs.claim"] = (ctx, input) => {
    const i = parse(runInput, input);
    const r = leaseOf(ctx, i, true);
    if (r.status !== "queued") throw fail("PRECONDITION_FAILED", "This run is already claimed.");
    const lease = leaseAt(ctx.now);
    ctx.server.commit(ctx.tx, [[`run:${r.id}`, { ...r, status: "running", lease }]], ctx.now);
    ctx.tx.leasePut({ run: r.id, until: ctx.now + LEASE_MS });
    return { attempt: r.attempt, lease, turns: turnsOf(ctx.tx, r) };
  };

  h["runs.heartbeat"] = (ctx, input) => {
    const i = parse(runInput.extend({ attempt: z.number().int().nonnegative() }), input);
    const r = leaseOf(ctx, i);
    const lease = leaseAt(ctx.now);
    ctx.server.commit(ctx.tx, [[`run:${r.id}`, { ...r, lease }]], ctx.now);
    ctx.tx.leasePut({ run: r.id, until: ctx.now + LEASE_MS });
    return { lease };
  };

  h["runs.turn"] = (ctx, input) => {
    const i = parse(runInput.extend({ attempt: z.number().int().nonnegative(), turn: z.unknown() }), input);
    const r = leaseOf(ctx, i);
    // a turn is progress, not a heartbeat: it does not extend the lease. Its
    // text goes to the run's readers as an in-flight event (ADR-22).
    const text = typeof i.turn === "string" ? i.turn : JSON.stringify(i.turn ?? null);
    ctx.server.emitRun({ type: "run", run: r.id, attempt: r.attempt, seq: 0, text }, r);
    return null;
  };

  h["runs.finish"] = (ctx, input) => {
    const i = parse(runInput.extend({ attempt: z.number().int().nonnegative(), answer: z.string() }), input);
    const r = leaseOf(ctx, i);
    if (Buffer.byteLength(i.answer) > DEVICE_ANSWER_MAX) {
      endRun(ctx, r, "too_large");
      return { status: "too_large" };
    }
    const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "complete", end: null, lease: null }]];
    if (r.node === "r") {
      const p = ctx.tx.get(`thread:${r.th}`);
      if (p?.kind === "thread" && p.mod === null && !p.del)
        writes.push([`thread:${p.id}`, { ...p, sum: i.answer, running: false, tok: 0 }]);
    } else {
      const f = ctx.tx.get(`followup:${r.node}`);
      if (f?.kind === "followup" && f.mod === null && !f.del) writes.push([`followup:${f.id}`, { ...f, a: i.answer }]);
    }
    ctx.tx.leaseDelete(r.id);
    ctx.server.commit(ctx.tx, writes, ctx.now);
    return { status: "complete" };
  };
  return h;
}

export class OnlineCalls {
  private readonly handlers: OnlineHandlers;

  constructor(
    private readonly server: SyncServer,
    extra: Partial<OnlineHandlers> = {},
  ) {
    this.handlers = { ...defaultHandlers(), ...(extra as OnlineHandlers) };
  }

  call(actor: Actor | null, name: string, input: unknown): CallAnswer {
    const t0 = Date.now();
    const handler = Object.hasOwn(this.handlers, name) ? this.handlers[name] : undefined;
    if (!handler)
      return { ok: false, error: fail("NOT_FOUND", "The server has no procedure with this name.").toError(), serverTime: t0 };
    try {
      return this.server.run((tx) => {
        const now = this.server.time(tx);
        this.server.housekeep(tx, now);
        try {
          const result = handler({ tx, now, actor, server: this.server }, input);
          return { ok: true as const, result: result ?? null, serverTime: now };
        } catch (e) {
          if (e instanceof pkg.Refusal) throw new Refused(e, now);
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof Refused) return { ok: false, error: e.refusal.toError(), serverTime: e.at };
      return { ok: false, error: fail("INTERNAL_SERVER_ERROR").toError(), serverTime: t0 };
    }
  }

  /** Whether a device's token is live and its person's. */
  deviceLive(tx: StoreTx, u: string, device: string): boolean {
    const t = tx.tokenGet(device);
    return t !== undefined && t.u === u && t.revokedAt === null;
  }

  /** The person and device a device token authenticates, or null. Writes the
   * device's `seen` at most once an hour. */
  authenticate(token: string): Actor | null {
    if (typeof token !== "string" || token.length > 200) return null;
    return this.server.run((tx) => {
      const now = this.server.time(tx);
      const t = tx.tokenByHash(sha256(token));
      if (!t || t.revokedAt !== null) return null;
      const d = tx.get(`device:${t.device}`);
      if (d?.kind === "device" && (d.seen === null || pkg.msOf(d.seen) < now - SEEN_EVERY))
        this.server.commit(tx, [[`device:${d.id}`, { ...d, seen: pkg.isoAt(now) }]], now);
      return { u: t.u, device: t.device };
    });
  }

  /** End the device runs whose lease ended, and drop expired sign-ins. */
  housekeep(tx: StoreTx, now: number, limit: number) {
    for (const l of tx.leasesBefore(now, limit)) {
      const r = tx.get(`run:${l.run}`);
      if (r?.kind === "run" && r.status === "running")
        endRun({ tx, now, actor: null, server: this.server }, r, "interrupted");
      else tx.leaseDelete(l.run);
    }
    tx.signinsPrune(now - SIGNIN_TTL, limit);
  }
}

/** A refusal thrown out of the transaction, so it rolls back. */
class Refused extends Error {
  constructor(
    readonly refusal: pkg.Refusal,
    readonly at: number,
  ) {
    super(refusal.message);
  }
}

export type { SseEvent };
