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
// app calls after its sign-in was approved to take its token, once. The
// device record and its token are made then: a sign-in nobody takes leaves
// neither (review round 1 of phase 1, E20).
//
// Device runs (review round 1 of phase 1, H1, H2, W1, W2, W3, W8):
// - A run's calls are checked at call time like a write in the run's space:
//   the caller reads the run and may write there (not banned; in a closed
//   space, a member). A run whose person lost that is ended (`failed`,
//   `access`) and the call refused, in one commit; so are the queued and
//   running device runs of a person whose membership ends or who is banned
//   (`accessChanged`), and those of a revoked device.
// - The lease (until, last heartbeat, the sequence of the attempt's events)
//   lives in `sync_leases` only: a heartbeat writes no record and changes no
//   log. A call after the lease ended ends the run `interrupted`.
// - `runs.claim` serves the thread's turns as the caller reads them: an item
//   redacted for them is no turn.
// - An answer lands only on the attempt the ask is at (`att`).
// - In-flight text goes out after the call commits, numbered per attempt.
//
// Review round 2 of phase 1:
// - In-flight text goes only to a reader for whom the run's node (its
//   thread, or its follow-up) reads unredacted (`textShown`), as a turn of
//   `runs.claim` (H1).
// - An answer written to a hidden item counts as an edit of it, so a
//   "shown" decided on the earlier text is STALE (W1).
// - A run's calls come from its device's token only: a browser session of
//   the same person drives no device run.
// - A call's input is at most MAX_CALL_BYTES as JSON and a turn at most
//   DEVICE_TURN_MAX bytes (TOO_LARGE, nothing written).
// - In an archived space a run's calls answer PRECONDITION_FAILED, as
//   `followups.ask` does; archiving a space ends its queued and running
//   device runs (`interrupted`, `spaceArchived`).
// - A run whose job became a dead letter ends (`jobDead`).
// - The approver may deny an approved sign-in whose token nobody took; a
//   revoked device's streams close.

import { createHash, randomBytes } from "node:crypto";

import * as pkg from "@session/mutators";
import { spaces } from "@session/shared";
import { z } from "zod";

import { HOUR, MINUTE, type Actor, type CallAnswer } from "../protocol.js";

import { answerWrites, bounds } from "./limits.js";
import type { SyncServer } from "./server.js";
import type { Lease, StoreTx } from "./store.js";

/** A device run's lease, and the largest device answer (server settings). */
export const LEASE_MS = 90_000;
export const DEVICE_ANSWER_MAX = 200 * 1024;
/** The largest in-flight turn, in bytes (TOO_LARGE above it). */
export const DEVICE_TURN_MAX = 64 * 1024;
/** The largest input of an online call, as JSON (TOO_LARGE above it). It
 * leaves room for an answer over DEVICE_ANSWER_MAX, which ends its run
 * `too_large`. */
export const MAX_CALL_BYTES = 1024 * 1024;
/** How deep an online call's input may nest (BAD_REQUEST deeper). */
export const MAX_CALL_DEPTH = 32;
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

/** A refusal answered after the call's writes commit: a handler returns it
 * (not throws it) when the refusal ends something, such as a run. */
export class CommittedRefusal {
  constructor(readonly refusal: pkg.Refusal) {}
}

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

/** A `Reader` over a transaction. */
const readerOf = (tx: StoreTx): pkg.Reader => ({
  get: <K extends pkg.Kind>(kind: K, id: string) =>
    tx.get(pkg.keyFor(kind, id)) as pkg.RecordOf<K> | undefined,
});

/** Whether `u` may write in space `sp` now, as a mutator's `inSpace(sp,
 * "member")` decides: the space exists, they are not banned from it, and in
 * a closed space they are a member. */
export function writesIn(g: pkg.Reader, sp: string, u: string): boolean {
  const s = pkg.spaceRec(g, sp);
  if (!s || s.deleted || pkg.bannedFrom(g, sp, u)) return false;
  return !pkg.isClosed(s) || pkg.roleIn(g, sp, u) !== null;
}

/** Whether a run's person may still run it: they read it, and may write in
 * its space. */
const mayRun = (g: pkg.Reader, r: pkg.RunRec) => pkg.canRead(g, r, r.u) && writesIn(g, r.s, r.u);

const live = (r: pkg.RunRec) => r.status === "queued" || r.status === "running";

/** A run of the caller's, run by the calling device: for every call but
 * claim, the attempt that holds a lease that has not ended. Answers the run
 * and its lease, or a refusal to return (after ending the run). */
function leaseOf(
  ctx: CallCtx,
  i: { run: string; device: string; attempt?: number },
  claim = false,
): { run: pkg.RunRec; lease: Lease | undefined } | CommittedRefusal {
  const a = need(ctx);
  // a browser session, or another device, drives no device run
  if (a.device !== i.device) throw fail("FORBIDDEN", "This run runs on another device.");
  const g = readerOf(ctx.tx);
  const r = ctx.tx.get(`run:${i.run}`);
  if (r?.kind !== "run") throw fail("NOT_FOUND", "The server has no record of this run.");
  const reads = pkg.canRead(g, r, a.u);
  if (!r.executor || r.executor.u !== a.u) {
    if (!reads) throw fail("NOT_FOUND", "The server has no record of this run.");
    throw fail("FORBIDDEN", "This run isn’t one of your device runs.");
  }
  if (r.executor.device !== i.device) throw fail("FORBIDDEN", "This run runs on another device.");
  if (!ctx.server.online.deviceLive(ctx.tx, a.u, i.device))
    throw fail("FORBIDDEN", "This device was signed out.");
  // checked at call time, as a write in the run's space is
  if (!reads || !writesIn(g, r.s, a.u)) {
    if (live(r)) endRun(ctx, r, "access");
    return new CommittedRefusal(
      reads ? fail("FORBIDDEN") : fail("NOT_FOUND", "The server has no record of this run."),
    );
  }
  if (pkg.spaceRec(g, r.s)?.archived)
    throw fail("PRECONDITION_FAILED", "This space is archived: nobody can ask in it.");
  const lease = ctx.tx.leaseGet(r.id);
  if (claim) return { run: r, lease };
  if (r.status !== "running" || r.attempt !== i.attempt)
    throw fail("PRECONDITION_FAILED", "This attempt no longer holds the run’s lease.");
  if (!lease || lease.until <= ctx.now) {
    endRun(ctx, r, "interrupted");
    return new CommittedRefusal(
      fail("PRECONDITION_FAILED", "This attempt no longer holds the run’s lease."),
    );
  }
  return { run: r, lease };
}

const leaseView = (l: Lease) => ({ until: pkg.isoAt(l.until), beat: pkg.isoAt(l.beat) });

/** The node a run answers: its thread (`node` "r") or its follow-up. */
function nodeOf(tx: StoreTx, r: pkg.RunRec) {
  const n = tx.get(r.node === "r" ? `thread:${r.th}` : `followup:${r.node}`);
  return n?.kind === "thread" || n?.kind === "followup" ? n : undefined;
}

/** End a run without an answer: its lease ended, its answer was too large,
 * its person lost access to its space, its device was revoked, its space
 * was archived, or its job became a dead letter. The thread stops running
 * when the run is its ask's current attempt. */
function endRun(ctx: CallCtx, r: pkg.RunRec, why: pkg.RunEnd) {
  const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "failed", end: why }]];
  const p = ctx.tx.get(`thread:${r.th}`);
  if (r.node === "r" && p?.kind === "thread" && p.att === r.attempt && p.running)
    writes.push([`thread:${p.id}`, { ...p, running: false }]);
  ctx.tx.leaseDelete(r.id);
  ctx.server.commit(ctx.tx, writes, ctx.now);
}

/** Store the next turn of run `r` (numbered from 1 within the run), as its
 * executor wrote it. Answers its number. */
export function storeTurn(ctx: CallCtx, r: pkg.RunRec, body: unknown): number {
  const n = ctx.tx.scan("turn", "run", r.id).length + 1;
  const turn: pkg.Draft<pkg.TurnRec> = {
    kind: "turn",
    run: r.id,
    th: r.th,
    s: r.s,
    u: r.u,
    node: r.node,
    attempt: r.attempt,
    n,
    body,
    createdAt: pkg.isoAt(ctx.now),
  };
  ctx.server.commit(ctx.tx, [[`turn:${r.id}:${n}`, turn]], ctx.now);
  return n;
}

/** Whether `u` reads item `x` as it is stored: they may read it, and it is
 * not redacted for them (hidden, and neither theirs nor in a space they
 * moderate). */
const unredacted = (g: pkg.Reader, x: pkg.StoredRecord, u: string | null) =>
  pkg.canRead(g, x, u) && pkg.redact(g, x, u) === x;

/** Every turn a run rebuilds its context from (no CLI session resumes), as
 * the run's person reads them now: an item redacted for them (hidden, and
 * not theirs) is no turn. */
function turnsOf(tx: StoreTx, r: pkg.RunRec) {
  const g = readerOf(tx);
  const shown = <T extends pkg.StoredRecord>(x: T): T | null => (unredacted(g, x, r.u) ? x : null);
  const p = tx.get(`thread:${r.th}`);
  if (p?.kind !== "thread" || pkg.view(g, p, r.u) === null) return [];
  const fus = tx
    .scan("followup", "th", p.id)
    .filter(
      (f): f is pkg.FollowUpRec =>
        f.kind === "followup" && f.mod === null && !f.del && shown(f) !== null,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const ask = shown(p) === null ? [] : [{ q: p.q, a: p.sum ?? "" }];
  return [...ask, ...fus.map((f) => ({ q: f.q, a: f.a ?? "" }))];
}

const stub =
  (name: string): Handler =>
  () => {
    throw fail("METHOD_NOT_SUPPORTED", `${name} is not served by this server.`);
  };

/** Where the raw values of API keys live (phase 2a): outside the records,
 * encrypted at rest by the server that implements it, in the same
 * transaction as the call's records. Only an `apikey` record (id, name,
 * provider, status, cap) reaches a client. */
export interface KeyVault {
  /** The id of `u`'s key whose raw value is `raw`, if any. */
  find(tx: StoreTx, u: string, raw: string): string | null;
  /** Store (or replace) the raw value of `u`'s key `id`. */
  put(tx: StoreTx, u: string, id: string, raw: string, now: number): void;
  delete(tx: StoreTx, u: string, id: string): void;
}

/** A vault in memory (tests; a server without key storage). */
export class MemoryKeyVault implements KeyVault {
  readonly keys = new Map<string, { u: string; raw: string }>();
  find(_tx: StoreTx, u: string, raw: string) {
    for (const [id, k] of this.keys) if (k.u === u && k.raw === raw) return id;
    return null;
  }
  put(_tx: StoreTx, u: string, id: string, raw: string) {
    this.keys.set(id, { u, raw });
  }
  delete(_tx: StoreTx, _u: string, id: string) {
    this.keys.delete(id);
  }
}

/** The provider of a raw API key, by its prefix (the mock's `keyProvider`). */
export const keyProvider = (raw: string) =>
  raw.startsWith("AIza")
    ? "Google"
    : raw.startsWith("sk-ant-")
      ? "Anthropic"
      : raw.startsWith("sk-or-")
        ? "OpenRouter"
        : "OpenAI";

/** The mask a client shows for a raw key (the mock's `keyMask`). */
export const keyMask = (raw: string) =>
  `${raw.slice(0, raw.startsWith("sk-ant-") ? 7 : raw.startsWith("AIza") ? 4 : 3)}…${raw.slice(-4)}`;

const keyInput = z.strictObject({ id: z.string().max(64) });

/** The caller's API key `id`, or NOT_FOUND. */
function ownKey(ctx: CallCtx, id: string): pkg.ApiKeyRec {
  const a = need(ctx);
  const k = ctx.tx.get(`apikey:${id}`);
  if (k?.kind !== "apikey" || k.u !== a.u)
    throw fail("NOT_FOUND", "The server has no record of this API key.");
  return k;
}

/** A raw key as stored: trimmed, at least 8 characters, and not one of the
 * caller's other keys (CONFLICT). */
function rawKey(ctx: CallCtx, vault: KeyVault, raw: string, except?: string): string {
  const a = need(ctx);
  const v = raw.trim();
  if (v.length < 8 || v.length > 512)
    throw fail("BAD_REQUEST", undefined, ["input.raw: expected an API key"]);
  const other = vault.find(ctx.tx, a.u, v);
  if (other !== null && other !== except)
    throw fail("CONFLICT", "This key has already been added.");
  return v;
}

/** The ask a run control names, its thread, and the follow-up (null for the
 * thread's ask), checked as the author's write in its space: the caller
 * wrote the ask, reads it, may write in the space, and the space is not
 * archived. */
function ownAsk(ctx: CallCtx, thread: string, node: string) {
  const a = need(ctx);
  const g = readerOf(ctx.tx);
  const p = ctx.tx.get(`thread:${thread}`);
  if (p?.kind !== "thread" || !pkg.canRead(g, p, a.u) || p.del)
    throw fail("NOT_FOUND", "The server has no record of this thread.");
  let f: pkg.FollowUpRec | null = null;
  if (node !== "r") {
    const x = ctx.tx.get(`followup:${node}`);
    if (x?.kind !== "followup" || x.th !== p.id || !pkg.canRead(g, x, a.u) || x.del)
      throw fail("NOT_FOUND", "The server has no record of this follow-up.");
    f = x;
  }
  if ((f ?? p).u !== a.u) throw fail("FORBIDDEN", "Only the person who asked can do this.");
  if (!writesIn(g, p.s, a.u)) throw fail("FORBIDDEN");
  if (pkg.spaceRec(g, p.s)?.archived)
    throw fail("PRECONDITION_FAILED", "This space is archived: nobody can ask in it.");
  if ((f ?? p).mod !== null) throw fail("PRECONDITION_FAILED", "This ask was removed.");
  return { u: a.u, p, f };
}

/** The queued and running runs of an ask. */
const liveRuns = (tx: StoreTx, th: string, node: string) =>
  tx
    .scan("run", "th", th)
    .filter((r): r is pkg.RunRec => r.kind === "run" && r.node === node && live(r));

export function defaultHandlers(
  vault: KeyVault = new MemoryKeyVault(),
  hooks: { cancelled?: (run: string) => void } = {},
): OnlineHandlers {
  const h: OnlineHandlers = {};
  for (const name of Object.keys(pkg.NOT_MUTATORS)) h[name] = stub(name);

  // ---- run controls (phase 2a; report-1b finding 7) ----

  // Stop: the run of an ask ends `cancelled` (`stopped`); a server job's loop
  // hears it after the call commits and stops, a device's next call is
  // refused (the run is no longer running). The tokens it used are the job's
  // to record.
  h["research.cancelNode"] = (ctx, input) => {
    const i = parse(P["research.cancelNode"].input.strict(), input);
    const { p } = ownAsk(ctx, i.thread, i.node);
    const runs = liveRuns(ctx.tx, p.id, i.node);
    if (!runs.length) throw fail("PRECONDITION_FAILED", "This answer isn’t running.");
    const writes: pkg.Write[] = runs.map((r) => [
      `run:${r.id}`,
      { ...r, status: "cancelled", end: "stopped" },
    ]);
    if (i.node === "r" && p.running) writes.push([`thread:${p.id}`, { ...p, running: false }]);
    for (const r of runs) ctx.tx.leaseDelete(r.id);
    ctx.server.commit(ctx.tx, writes, ctx.now);
    for (const r of runs) ctx.server.afterCommit(() => hooks.cancelled?.(r.id));
    return null;
  };

  // Run again: a new run of the ask at its next attempt, as `threads.update`
  // and `followups.update` with `run` write one: the answer is cleared (an
  // edit of a hidden item), earlier runs of the ask are cancelled, and the
  // run's job is queued. An online call, so the run's id is the server's.
  h["research.retryNode"] = (ctx, input) => {
    const i = parse(P["research.retryNode"].input.strict(), input);
    const { u, p, f } = ownAsk(ctx, i.thread, i.node);
    if (p.k !== "ask") throw fail("BAD_REQUEST", undefined, ["input.thread: expected an ask"]);
    if ((f === null && p.running) || liveRuns(ctx.tx, p.id, i.node).length)
      throw fail("PRECONDITION_FAILED", "This answer is running.");
    const pay = i.pay ?? null;
    if (pay !== null && pay !== "session") ownKey(ctx, pay);
    const ex = i.executor ?? null;
    if (ex) {
      const d = ctx.tx.get(`device:${ex.device}`);
      if (d?.kind !== "device" || d.u !== u)
        throw fail("FORBIDDEN", "This device isn’t one of yours.");
      const since = ctx.now - HOUR;
      const recent = ctx.tx
        .deviceRunsSince(u, since)
        .filter((at) => at > since)
        .sort((a, b) => a - b);
      if (recent.length >= pkg.DEVICE_RUNS_PER_HOUR)
        throw pkg.refuse(
          "TOO_MANY_REQUESTS",
          `You started ${pkg.DEVICE_RUNS_PER_HOUR} device runs in the past hour.`,
          undefined,
          pkg.isoAt((recent[recent.length - pkg.DEVICE_RUNS_PER_HOUR] ?? ctx.now) + HOUR),
        );
    }
    const att = (f ?? p).att + 1;
    const model = i.model ?? (f ?? p).model;
    // an admin-only model runs on the included tokens for an admin only
    // (review round 1 of phase 2, F1)
    if (
      !ex &&
      (pay === null || pay === "session") &&
      pkg.adminOnlyModel(model) &&
      !ctx.server.includedModel(u, model)
    )
      throw fail(
        "FORBIDDEN",
        "This model doesn’t run on the included tokens. Choose an API key of yours to pay for it.",
      );
    const id = ctx.server.newId(ctx.tx, ctx.now);
    const writes: pkg.Write[] = [
      ...answerWrites(
        ctx.tx,
        f === null
          ? {
              ...p,
              sum: null,
              tok: 0,
              running: true,
              att,
              pay,
              model,
              updatedAt: pkg.isoAt(ctx.now),
            }
          : { ...f, a: null, att, pay, model },
      ),
    ];
    for (const r of ctx.tx.scan("run", "th", p.id))
      if (r.kind === "run" && r.node === i.node && live(r))
        writes.push([`run:${r.id}`, { ...r, status: "cancelled", end: "stopped" }]);
    writes.push([
      `run:${id}`,
      {
        kind: "run",
        id,
        th: p.id,
        s: p.s,
        u,
        node: i.node,
        status: "queued",
        end: null,
        attempt: att,
        pay: ex ? null : pay,
        model,
        executor: ex ? { kind: "device", cli: ex.cli, device: ex.device, u } : null,
        createdAt: pkg.isoAt(ctx.now),
      },
    ]);
    const many = ctx.server.tooManyRuns(ctx.tx, u, writes);
    if (many) throw pkg.refuse(many.code, many.message);
    ctx.server.commit(ctx.tx, writes, ctx.now);
    if (ex) ctx.tx.deviceRunAdd(u, ctx.now);
    ctx.tx.effectAdd({ type: "job", kind: "run", id }, ctx.now);
    return null;
  };

  // ---- API keys (phase 2a; report-1b finding 7) ----
  // The raw key goes to the vault; the `apikey` record holds id, name,
  // provider, status and cap. A check is a server job (`key`): the key is
  // "checking" until the job writes the provider's verdict (`keyChecked`).

  h["apiKeys.create"] = (ctx, input) => {
    const a = need(ctx);
    const i = parse(P["apiKeys.create"].input.strict(), input);
    const raw = rawKey(ctx, vault, i.raw);
    const id = ctx.server.newId(ctx.tx, ctx.now);
    const n = ctx.tx.scan("apikey", "u", a.u).length + 1;
    const name = i.label.trim().slice(0, 200) || `API key ${n}`;
    const cap = Math.max(0, Math.floor(i.cap ?? 0));
    ctx.server.commit(
      ctx.tx,
      [
        [
          `apikey:${id}`,
          {
            kind: "apikey",
            id,
            u: a.u,
            name,
            provider: keyProvider(raw),
            status: i.check ? "checking" : "valid",
            cap,
          },
        ],
      ],
      ctx.now,
    );
    vault.put(ctx.tx, a.u, id, raw, ctx.now);
    if (i.check) ctx.tx.effectAdd({ type: "job", kind: "key", id }, ctx.now);
    return { id };
  };

  h["apiKeys.replace"] = (ctx, input) => {
    const i = parse(P["apiKeys.replace"].input.strict(), input);
    const k = ownKey(ctx, i.id);
    const raw = rawKey(ctx, vault, i.raw, k.id);
    ctx.server.commit(
      ctx.tx,
      [[`apikey:${k.id}`, { ...k, provider: keyProvider(raw), status: "checking" }]],
      ctx.now,
    );
    vault.put(ctx.tx, k.u, k.id, raw, ctx.now);
    ctx.tx.effectAdd({ type: "job", kind: "key", id: k.id }, ctx.now);
    return null;
  };

  h["apiKeys.check"] = (ctx, input) => {
    const i = parse(keyInput, input);
    const k = ownKey(ctx, i.id);
    ctx.server.commit(ctx.tx, [[`apikey:${k.id}`, { ...k, status: "checking" }]], ctx.now);
    ctx.tx.effectAdd({ type: "job", kind: "key", id: k.id }, ctx.now);
    return null;
  };

  h["apiKeys.rename"] = (ctx, input) => {
    const i = parse(P["apiKeys.rename"].input.strict(), input);
    const k = ownKey(ctx, i.id);
    const name = i.label.trim().slice(0, 200);
    if (!name) throw fail("BAD_REQUEST", undefined, ["input.label: expected some text"]);
    ctx.server.commit(ctx.tx, [[`apikey:${k.id}`, { ...k, name }]], ctx.now);
    return null;
  };

  h["apiKeys.setCap"] = (ctx, input) => {
    const i = parse(P["apiKeys.setCap"].input.strict(), input);
    const k = ownKey(ctx, i.id);
    if (!Number.isFinite(i.cap) || i.cap < 0)
      throw fail("BAD_REQUEST", undefined, ["input.cap: expected a number of tokens, 0 or more"]);
    ctx.server.commit(ctx.tx, [[`apikey:${k.id}`, { ...k, cap: Math.floor(i.cap) }]], ctx.now);
    return null;
  };

  h["apiKeys.revoke"] = (ctx, input) => {
    const i = parse(keyInput, input);
    const k = ownKey(ctx, i.id);
    ctx.server.commit(ctx.tx, [[`apikey:${k.id}`, null]], ctx.now);
    vault.delete(ctx.tx, k.u, k.id);
    return null;
  };

  h["devices.authorize"] = (ctx, input) => {
    const i = parse(P["devices.authorize"].input.strict(), input);
    const name = i.name.trim();
    if (!name) throw fail("BAD_REQUEST", undefined, ["input.name: expected some text"]);
    const request = ctx.server.newId(ctx.tx, ctx.now);
    let code = "";
    for (let k = 0; k < 6; k++)
      code += CODE.charAt(Math.floor(ctx.server.randomNumber() * CODE.length));
    ctx.tx.signinPut({
      request,
      code,
      name,
      kind: i.kind ?? "mac",
      at: ctx.now,
      state: "waiting",
      u: null,
      device: null,
    });
    return { request, code: `${code.slice(0, 3)}-${code.slice(3)}`, url: "session.app/device" };
  };

  // Approved in the browser (review round 1 of phase 1, E17): a device's
  // token signs in no other device. The device's id is chosen here, and
  // kept in the registry; its record and token are made when the app takes
  // the token.
  h["devices.approve"] = (ctx, input) => {
    const a = need(ctx);
    if (a.device != null)
      throw fail("FORBIDDEN", "Approve a device’s sign-in from a browser, not from a device.");
    const i = parse(P["devices.approve"].input.strict(), input);
    const s = ctx.tx.signinGet(i.request);
    // the approver takes back an approval whose token nobody took yet
    // (review round 2 of phase 1)
    if (s && s.state === "approved" && s.u === a.u && i.deny && s.at >= ctx.now - SIGNIN_TTL) {
      ctx.tx.signinPut({ ...s, state: "denied" });
      return { device: null };
    }
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
    ctx.tx.registrySet(id, 0);
    ctx.tx.signinPut({ ...s, state: "approved", u: a.u, device: id });
    return { device: id };
  };

  h["devices.token"] = (ctx, input) => {
    const i = parse(z.strictObject({ request: z.string().max(64) }), input);
    const s = ctx.tx.signinGet(i.request);
    if (!s || s.at < ctx.now - SIGNIN_TTL || s.state === "taken")
      throw fail("NOT_FOUND", "The server has no record of this sign-in. It may have expired.");
    if (s.state === "denied") throw fail("FORBIDDEN", "The sign-in was denied.");
    if (s.state !== "approved" || s.u === null || s.device === null)
      throw fail("PRECONDITION_FAILED", "The sign-in is waiting for its approval.");
    const token = randomBytes(32).toString("base64url");
    ctx.tx.tokenPut({ device: s.device, u: s.u, hash: sha256(token), revokedAt: null });
    ctx.server.commit(
      ctx.tx,
      [
        [
          `device:${s.device}`,
          {
            kind: "device",
            id: s.device,
            u: s.u,
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
    ctx.tx.signinPut({ ...s, state: "taken" });
    return { token, device: s.device, u: s.u };
  };

  // Its unsent writes are refused (its clients are gone: WRONG_CLIENT), and
  // its queued and running runs end (review round 1 of phase 1, E18).
  h["devices.revoke"] = (ctx, input) => {
    const a = need(ctx);
    const i = parse(P["devices.revoke"].input.strict(), input);
    const d = ctx.tx.get(`device:${i.id}`);
    if (d?.kind !== "device" || d.u !== a.u)
      throw fail("NOT_FOUND", "The server has no record of this device.");
    const t = ctx.tx.tokenGet(d.id);
    if (t) ctx.tx.tokenPut({ ...t, revokedAt: ctx.now });
    for (const c of ctx.tx.clientsOfDevice(d.id)) ctx.tx.clientDelete(c);
    for (const r of ctx.tx.scan("run", "u", a.u))
      if (r.kind === "run" && r.executor?.device === d.id && live(r)) endRun(ctx, r, "access");
    ctx.server.commit(ctx.tx, [[`device:${d.id}`, null]], ctx.now);
    // its open streams close once this commits (review round 2 of phase 1)
    ctx.server.emitRevoke(d.id);
    return null;
  };

  h["runs.claim"] = (ctx, input) => {
    const i = parse(runInput, input);
    const l = leaseOf(ctx, i, true);
    if (l instanceof CommittedRefusal) return l;
    const r = l.run;
    if (r.status !== "queued") throw fail("PRECONDITION_FAILED", "This run is already claimed.");
    const lease: Lease = { run: r.id, until: ctx.now + LEASE_MS, beat: ctx.now, seq: 0 };
    ctx.server.commit(ctx.tx, [[`run:${r.id}`, { ...r, status: "running" }]], ctx.now);
    ctx.tx.leasePut(lease);
    return { attempt: r.attempt, lease: leaseView(lease), turns: turnsOf(ctx.tx, r) };
  };

  // A heartbeat extends the lease in `sync_leases` only: it writes no record.
  h["runs.heartbeat"] = (ctx, input) => {
    const i = parse(runInput.extend({ attempt: z.number().int().nonnegative() }), input);
    const l = leaseOf(ctx, i);
    if (l instanceof CommittedRefusal) return l;
    const lease: Lease = { ...(l.lease as Lease), until: ctx.now + LEASE_MS, beat: ctx.now };
    ctx.tx.leasePut(lease);
    return { lease: leaseView(lease) };
  };

  h["runs.turn"] = (ctx, input) => {
    const i = parse(
      runInput.extend({ attempt: z.number().int().nonnegative(), turn: z.unknown() }),
      input,
    );
    const text = typeof i.turn === "string" ? i.turn : JSON.stringify(i.turn ?? null);
    if (Buffer.byteLength(text) > DEVICE_TURN_MAX)
      throw fail("TOO_LARGE", undefined, [`input.turn: expected at most ${DEVICE_TURN_MAX} bytes`]);
    const l = leaseOf(ctx, i);
    if (l instanceof CommittedRefusal) return l;
    const r = l.run;
    // a turn is progress, not a heartbeat: it does not extend the lease. It
    // is stored as a `turn` record of the run (phase 2a; report-1b finding
    // 6), so a reader pulls it and a later run rebuilds its context from it,
    // and its text also goes to the readers of the run's node as an
    // in-flight event (ADR-22), once the call is stored, numbered within the
    // attempt.
    const lease = l.lease as Lease;
    const seq = lease.seq + 1;
    ctx.tx.leasePut({ ...lease, seq });
    storeTurn(ctx, r, i.turn ?? null);
    ctx.server.emitRun({ type: "run", run: r.id, attempt: r.attempt, seq, text }, r);
    return null;
  };

  h["runs.finish"] = (ctx, input) => {
    const i = parse(
      runInput.extend({ attempt: z.number().int().nonnegative(), answer: z.string() }),
      input,
    );
    const l = leaseOf(ctx, i);
    if (l instanceof CommittedRefusal) return l;
    const r = l.run;
    if (Buffer.byteLength(i.answer) > DEVICE_ANSWER_MAX) {
      endRun(ctx, r, "too_large");
      return { status: "too_large" };
    }
    const writes: pkg.Write[] = [[`run:${r.id}`, { ...r, status: "complete", end: null }]];
    // the answer lands on the attempt the ask is at, never on a later one;
    // on a hidden item it counts as an edit (W1)
    const n = nodeOf(ctx.tx, r);
    if (n && n.mod === null && !n.del && n.att === r.attempt)
      writes.push(
        ...answerWrites(
          ctx.tx,
          n.kind === "thread"
            ? { ...n, sum: i.answer, running: false, tok: 0 }
            : { ...n, a: i.answer },
        ),
      );
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
    vault?: KeyVault,
    private readonly hooks: { cancelled?: (run: string) => void } = {},
  ) {
    this.handlers = { ...defaultHandlers(vault, hooks), ...(extra as OnlineHandlers) };
  }

  /** End run `r` (`why`) in the commit in progress; a server job's run is
   * also stopped once that commit is stored (its loop aborts). */
  private endLive(ctx: CallCtx, r: pkg.RunRec, why: pkg.RunEnd) {
    endRun(ctx, r, why);
    if (r.executor === null) this.server.afterCommit(() => this.hooks.cancelled?.(r.id));
  }

  /** Whether a call of this name is served (a handler that is no stub). */
  has(name: string): boolean {
    return Object.hasOwn(this.handlers, name);
  }

  call(actor: Actor | null, name: string, input: unknown): CallAnswer {
    const t0 = this.server.clockNow();
    const handler = Object.hasOwn(this.handlers, name) ? this.handlers[name] : undefined;
    if (!handler)
      return {
        ok: false,
        error: fail("NOT_FOUND", "The server has no procedure with this name.").toError(),
        serverTime: t0,
      };
    // bounded before anything parses it (review round 2 of phase 1)
    const b = bounds(input, MAX_CALL_DEPTH + 1, MAX_CALL_BYTES);
    if (b !== "ok" || Buffer.byteLength(JSON.stringify(input) ?? "") > MAX_CALL_BYTES)
      return {
        ok: false,
        error: (b === "deep"
          ? fail("BAD_REQUEST", undefined, [
              `input: expected nesting at most ${MAX_CALL_DEPTH} deep`,
            ])
          : fail("TOO_LARGE", undefined, [
              `input: expected at most ${MAX_CALL_BYTES} bytes as JSON`,
            ])
        ).toError(),
        serverTime: t0,
      };
    try {
      this.server.housekeepDue();
      return this.server.run((tx): CallAnswer => {
        const now = this.server.time(tx);
        try {
          const result = handler({ tx, now, actor, server: this.server }, input);
          // the call's writes commit, and it answers the refusal
          if (result instanceof CommittedRefusal)
            return { ok: false, error: result.refusal.toError(), serverTime: now };
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

  /** End the queued and running runs `u` may no longer run in space `sp`
   * (their membership ended, or they were banned), device runs and server
   * jobs alike: called in the commit of the write that changed it. A server
   * job's loop is stopped once that commit is stored (review round 1 of
   * phase 2, F3). */
  accessChanged(tx: StoreTx, now: number, sp: string, u: string) {
    const g = readerOf(tx);
    const ctx: CallCtx = { tx, now, actor: null, server: this.server };
    for (const r of tx.scan("run", "u", u))
      if (r.kind === "run" && r.s === sp && live(r) && !mayRun(g, r))
        this.endLive(ctx, r, "access");
  }

  /** Whether `u` may read run `r`'s in-flight text now: they read the run,
   * and its node reads unredacted for them (review round 2 of phase 1,
   * H1). */
  textShown(tx: StoreTx, r: pkg.RunRec, u: string | null): boolean {
    const g = readerOf(tx);
    const n = nodeOf(tx, r);
    return pkg.canRead(g, r, u) && n !== undefined && n.mod === null && unredacted(g, n, u);
  }

  /** End the queued and running runs of a space being archived
   * (`interrupted`), device runs and server jobs alike: called in the commit
   * that archives it. */
  spaceArchived(tx: StoreTx, now: number, sp: string) {
    const ctx: CallCtx = { tx, now, actor: null, server: this.server };
    for (const p of tx.scan("thread", "s", sp))
      for (const r of p.kind === "thread" ? tx.scan("run", "th", p.id) : [])
        if (r.kind === "run" && live(r)) this.endLive(ctx, r, "interrupted");
  }

  /** End a run whose job became a dead letter (`failed`, `interrupted`): it
   * will not start. */
  jobDead(tx: StoreTx, now: number, run: string) {
    const r = tx.get(`run:${run}`);
    if (r?.kind === "run" && live(r))
      endRun({ tx, now, actor: null, server: this.server }, r, "interrupted");
  }

  /** End the device runs whose lease ended, and drop expired sign-ins. */
  housekeep(tx: StoreTx, now: number, limit: number) {
    for (const l of tx.leasesBefore(now + 1, limit)) {
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
