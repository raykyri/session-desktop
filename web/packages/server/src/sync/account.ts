// Account state the spaces API serves outside the replicated logs (phase
// 2a): the reads `/api/me`, `/api/me/settings`, `/api/me/usage`,
// `/api/me/api-keys`, `/api/me/devices`, `/api/users` and the paged query
// `usage.listAsks`, in the mock's shapes (`spacesApi`), and the online calls
// the sync package leaves to the server (`settings.update`,
// `usage.setDefaultKey`, `usage.markMovedSeen`), through its handler
// interface. The payer rule (included tokens first, then the asker's default
// API key: the mock's `payer`) is here too, for `/api/me/usage` and the run
// pipeline.

import { apiKeys, preferences, usage, users, type SessionDatabase } from "@session/db";
import * as pkg from "@session/mutators";
import { spaces } from "@session/shared";
import { CommittedRefusal, type OnlineHandlers, type SyncServer } from "@session/sync/server";
import { z } from "zod";

import type { Config } from "../config.js";

const fail = (code: pkg.ErrorCode, message?: string, issues?: string[]) =>
  pkg.refuse(code, message, issues);

const isoAt = (ms: number) => new Date(ms).toISOString();

/** `u`'s API key records, as the sync store holds them. */
export function keyRecords(sync: SyncServer, u: string): pkg.ApiKeyRec[] {
  return sync.run((tx) =>
    tx.scan("apikey", "u", u).flatMap((r) => (r.kind === "apikey" && r.u === u ? [r] : [])),
  );
}

/** One source of tokens and what it has left this month. */
export interface TokenSource {
  id: string;
  kind: "session" | "key";
  cap: number;
  used: number;
  left: number;
  key?: pkg.ApiKeyRec;
}

/** The default API key: the one the person chose while it is valid, else
 * their first valid key. */
export function defaultKey(
  db: SessionDatabase,
  sync: SyncServer,
  userId: string,
  u: string,
): pkg.ApiKeyRec | null {
  const valid = keyRecords(sync, u)
    .filter((k) => k.status === "valid")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const def = preferences.ensure(db, userId).defaultKeyId;
  return valid.find((k) => k.id === def) ?? valid[0] ?? null;
}

/** A source of tokens by id (`session` or a key id of `u`'s), or null. */
export function tokenSource(
  db: SessionDatabase,
  sync: SyncServer,
  config: Config,
  userId: string,
  u: string,
  id: string,
  at = Date.now(),
): TokenSource | null {
  const used = usage.monthlyUsed(db, userId, id, at);
  if (id === "session") {
    const cap = config.sync.includedTokens;
    return { id, kind: "session", cap, used, left: Math.max(0, cap - used) };
  }
  const key = keyRecords(sync, u).find((k) => k.id === id);
  if (!key) return null;
  const left = key.status !== "valid" ? 0 : key.cap ? Math.max(0, key.cap - used) : Infinity;
  return { id, kind: "key", cap: key.cap, used, left, key };
}

/** Who pays for a run of `u`'s whose ask named `pay`: that source when it
 * has tokens left; with no payer named, the included tokens, then the
 * default key (the mock's `payer`). `fail`: the run ends (`tokens`, or `key`
 * for a key that is not valid). */
export function payerFor(
  db: SessionDatabase,
  sync: SyncServer,
  config: Config,
  userId: string,
  u: string,
  pay: string | null,
  at = Date.now(),
): { ok: true; source: TokenSource } | { ok: false; why: "tokens" | "key" } {
  if (pay !== null) {
    const s = tokenSource(db, sync, config, userId, u, pay, at);
    if (!s) return { ok: false, why: "key" };
    if (s.kind === "key" && s.key?.status !== "valid") return { ok: false, why: "key" };
    return s.left > 0 ? { ok: true, source: s } : { ok: false, why: "tokens" };
  }
  const order = ["session"];
  const d = defaultKey(db, sync, userId, u);
  if (d) order.push(d.id);
  for (const id of order) {
    const s = tokenSource(db, sync, config, userId, u, id, at);
    if (s && s.left > 0) return { ok: true, source: s };
  }
  return { ok: false, why: "tokens" };
}

// ---- reads ----

export function meOf(
  sync: SyncServer,
  user: { handle: string; name?: string | null; createdAt: number },
) {
  const p = sync.viewOf(`profile:${user.handle}`, user.handle);
  return {
    u: user.handle,
    name: p?.kind === "profile" ? p.name : (user.name ?? user.handle),
    bio: p?.kind === "profile" ? p.bio : "",
    x: "",
    createdAt: isoAt(user.createdAt),
  };
}

export function settingsOf(db: SessionDatabase, userId: string) {
  return preferences.ensure(db, userId).account;
}

export function usageOf(
  db: SessionDatabase,
  sync: SyncServer,
  config: Config,
  user: { id: string; handle: string; createdAt: number },
  at = Date.now(),
) {
  const prefs = preferences.ensure(db, user.id);
  const d = defaultKey(db, sync, user.id, user.handle);
  const by = usage.monthlyByPayer(db, user.id, at);
  return {
    cap: config.sync.includedTokens,
    resetAt: isoAt(usage.monthOf(at).end),
    def: d?.id ?? null,
    movedSeen: prefs.movedSeen,
    ...(at - user.createdAt < 60_000 ? { fresh: true } : {}),
    by,
  };
}

export function apiKeysOf(
  db: SessionDatabase,
  sync: SyncServer,
  user: { id: string; handle: string },
  at = Date.now(),
) {
  const rows = new Map(apiKeys.list(db, user.id).map((r) => [r.id, r]));
  const by = usage.monthlyByPayer(db, user.id, at);
  return keyRecords(sync, user.handle)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((k) => {
      const row = rows.get(k.id);
      const used = Object.values(by[k.id] ?? {}).reduce((a, b) => a + b, 0);
      return {
        id: k.id,
        kind: "key" as const,
        label: k.name,
        provider: k.provider,
        valid: k.status === "valid",
        ...(k.status === "checking" ? { check: "checking" as const } : {}),
        ...(row
          ? {
              mask: row.mask,
              createdAt: isoAt(row.createdAt),
              updatedAt: isoAt(row.updatedAt),
              lastUsedAt: row.lastUsedAt === null ? null : isoAt(row.lastUsedAt),
              ...(row.reason !== null && k.status === "invalid" ? { reason: row.reason } : {}),
            }
          : {}),
        used,
        cap: k.cap,
      };
    });
}

export function devicesOf(sync: SyncServer, u: string) {
  const records = sync.run((tx) =>
    // a person's devices are in their user log; read through the log so only
    // their own are served
    tx.logAfter(`user:${u}`, 0).flatMap((row) => {
      const r = row.key.startsWith("device:") ? tx.get(row.key) : undefined;
      return r?.kind === "device" && r.u === u ? [r] : [];
    }),
  );
  return records.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.type,
    plat: d.plat,
    createdAt: d.createdAt,
    lastSeenAt: d.seen,
  }));
}

/** `/api/users?handle=<h>`: the number of spaces each person wrote threads
 * in, closed spaces included (the mock's `people`). */
export function peopleOf(db: SessionDatabase, handles: string[]) {
  const out: Record<string, { spaces: number }> = {};
  const stmt = db.$client.prepare(
    "SELECT COUNT(DISTINCT json_extract(body, '$.s')) AS n FROM sync_records WHERE kind = 'thread' AND json_extract(body, '$.u') = ? AND json_extract(body, '$.gone') = 0",
  );
  for (const h of handles.slice(0, 100))
    out[h] = { spaces: (stmt.get(h) as { n: number } | undefined)?.n ?? 0 };
  return out;
}

/** `usage.listAsks`: the caller's asks and follow-ups that used tokens,
 * newest first, from their usage by run. */
export function listAsks(
  db: SessionDatabase,
  sync: SyncServer,
  user: { id: string; handle: string },
  input: { cursor?: string | null | undefined; limit?: number | undefined },
) {
  const rows = db.$client
    .prepare(
      "SELECT run_id AS run, MAX(created_at) AS at, SUM(input_tokens + output_tokens) AS tok, MAX(payer) AS pay FROM usage_events WHERE user_id = ? AND run_id IS NOT NULL AND kind <> 'run' GROUP BY run_id ORDER BY at DESC, run_id DESC",
    )
    .all(user.id) as { run: string; at: number; tok: number; pay: string | null }[];
  const items = rows.flatMap((r) => {
    const run = sync.viewOf(`run:${r.run}`, user.handle);
    if (run?.kind !== "run" || r.tok <= 0) return [];
    const node = sync.viewOf(
      run.node === "r" ? `thread:${run.th}` : `followup:${run.node}`,
      user.handle,
    );
    const t = node?.kind === "thread" ? node.t || node.q : node?.kind === "followup" ? node.q : "";
    return [
      {
        id: `${run.th}:${run.node}`,
        thread: run.th,
        node: run.node,
        space: run.s,
        t: t ?? "",
        u: run.u,
        tok: r.tok,
        pay: r.pay,
        ...(node === null || (node && "del" in node && node.del) ? { del: true as const } : {}),
        createdAt: isoAt(r.at),
        readable: node !== null,
      },
    ];
  });
  const start = Math.max(0, Number(input.cursor ?? 0) || 0);
  const limit = input.limit ?? 8;
  const page = items.slice(start, start + limit);
  return { items: page, nextCursor: start + limit < items.length ? String(start + limit) : null };
}

// ---- online calls the server serves ----

const P = spaces.spaceProcedures;

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

export function accountHandlers(db: SessionDatabase): Partial<OnlineHandlers> {
  const userOf = (actor: { u: string } | null) => {
    const user = actor ? users.findByHandle(db, actor.u) : null;
    if (!user) throw fail("UNAUTHORIZED");
    return user;
  };
  return {
    "settings.update": (ctx, input) => {
      const user = userOf(ctx.actor);
      const i = parse(P["settings.update"].input.strict(), input);
      if (i.emailNew && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.emailNew))
        throw fail("BAD_REQUEST", undefined, ["input.emailNew: expected an email address"]);
      const a = preferences.ensure(db, user.id).account;
      preferences.update(db, user.id, {
        account: {
          ...(i.emailOn !== undefined ? { emailOn: i.emailOn } : {}),
          ...(i.types ? { types: { ...a.types, ...i.types } } : {}),
          ...(i.spaces ? { spaces: { ...a.spaces, ...i.spaces } } : {}),
          ...(i.emailNew !== undefined ? { emailNew: i.emailNew } : {}),
          ...(i.export ? { exportAt: isoAt(ctx.now) } : {}),
        },
      });
      return null;
    },
    "usage.setDefaultKey": (ctx, input) => {
      const user = userOf(ctx.actor);
      const i = parse(P["usage.setDefaultKey"].input.strict(), input);
      if (i.id !== null) {
        const k = ctx.tx.get(`apikey:${i.id}`);
        if (k?.kind !== "apikey" || k.u !== user.handle)
          throw fail("NOT_FOUND", "The server has no record of this API key.");
        if (k.status !== "valid")
          return new CommittedRefusal(
            fail("PRECONDITION_FAILED", "The provider rejected this key."),
          );
      }
      preferences.update(db, user.id, { defaultKeyId: i.id });
      return null;
    },
    "usage.markMovedSeen": (ctx, input) => {
      const user = userOf(ctx.actor);
      parse(z.strictObject({}), input ?? {});
      preferences.update(db, user.id, { movedSeen: true });
      return null;
    },
  };
}
