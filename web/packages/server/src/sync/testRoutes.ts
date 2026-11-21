// The acceptance suite's test access over HTTP (`01` A1): what
// `@session/replica-proto`'s `TestServer` needs besides the API, served at
// `/api/sync/test/*` by a server whose `NODE_ENV` is `test` and never
// otherwise (`app.ts`). Each is the in-memory target's
// (`replica-proto/src/sync-target.ts`) over the SQLite tables:
//
//   POST /finish          { key, text }  what a finished run writes (`serverApply`)
//   POST /freeze          { space }      the operator job's freeze (`04` B6)
//   POST /replace-history { log }        a restore of one log (`01` D6)
//   GET  /log-rows        ?log           a log's rows
//   GET  /scan                           every value at rest
//   POST /apply-unreadable { envelope, unreadable }  an envelope whose named
//                                        fields throw when read, which no HTTP
//                                        body can carry (a hostile caller of
//                                        the in-process API); with none named
//                                        and no session, the server half's
//                                        answer to a signed-out caller, which
//                                        `/api/sync/apply` refuses with 401
//                                        before reading the body

import { DAY, type LogId, type StoredRecord } from "@session/mutators";
import { Hono } from "hono";

import type { AppEnv } from "../deps.js";

import type { SyncService } from "./service.js";

export function syncTestRoutes(sync: SyncService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { server, store } = sync;
  const db = store.sqlite;

  app.post("/finish", async (c) => {
    const { key, text } = await c.req.json<{ key: string; text: string }>();
    const r = store.byKey(key);
    if (!r || !("mod" in r) || r.mod === "removed") return c.json({ ok: false });
    // a run's writes make no ids: no mutation id from the random source
    const res = server.serverApply({ me: "", mutationId: "" }, (tx) => {
      const at = tx.now;
      /** The ask's run, `complete` if it had not ended. */
      const done = (th: string, node: string) => {
        const run = tx.list("run", { th }).find((x) => x.node === node);
        if (!run || (run.status !== "queued" && run.status !== "running")) return;
        tx.put({
          ...run,
          status: "complete",
          step: 3,
          startedAt: run.startedAt ?? at,
          finishedAt: at,
        });
      };
      if (r.kind === "thread" && !r.del) {
        tx.put({ ...r, sum: text, running: false });
        done(r.id, "r");
        return true;
      }
      if (r.kind === "node" && r.u !== null) {
        tx.put({
          kind: "answer",
          node: r.id,
          th: r.th,
          s: r.s,
          u: r.u,
          md: text,
          pages: [],
          tok: 0,
          run: r.run,
          attempt: 1,
          mod: r.mod,
        });
        done(r.th, r.id);
        return true;
      }
      return false;
    });
    return c.json({ ok: res.ok && res.result && res.version !== null });
  });

  app.post("/freeze", async (c) => {
    const { space } = await c.req.json<{ space: string }>();
    const s = store.byKey(`space:${space}`);
    if (s?.kind !== "space") return c.json({ ok: false });
    const res = server.serverApply({ me: "", mutationId: "" }, (tx) =>
      tx.put({ ...s, frozen: true }),
    );
    return c.json({ ok: res.ok });
  });

  app.post("/replace-history", async (c) => {
    const { log } = await c.req.json<{ log: LogId }>();
    server.replaceHistory(log);
    return c.json({ ok: true });
  });

  app.post("/apply-unreadable", async (c) => {
    const { envelope, unreadable } = await c.req.json<{
      envelope: Record<string, unknown>;
      unreadable: string[];
    }>();
    for (const k of unreadable)
      Object.defineProperty(envelope, k, {
        enumerable: true,
        get: () => {
          throw new Error("a getter that fails");
        },
      });
    const user = c.get("user");
    return c.json(server.apply(user?.handle ? { u: user.handle } : null, envelope));
  });

  app.get("/log-rows", (c) => {
    server.expire();
    return c.json(store.logRows((c.req.query("log") ?? "") as LogId, 0));
  });

  app.get("/scan", (c) => {
    server.expire();
    const now = server.now();
    const rows = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
    const answers = [
      ...rows<{ u: string; mutation_id: string; digest: string; result_json: string; at: number }>(
        "SELECT * FROM sync_answers ORDER BY at, u, mutation_id",
      ).map((a) => ({
        u: a.u,
        mutationId: a.mutation_id,
        digest: a.digest,
        result: JSON.parse(a.result_json) as unknown,
        at: a.at,
      })),
      ...rows<{
        client_id: string;
        seq: number;
        digest: string;
        result_json: string;
        at: number;
        u: string | null;
      }>(
        `SELECT a.*, c.u FROM sync_seq_answers a LEFT JOIN sync_clients c ON c.client_id = a.client_id
         ORDER BY a.at, a.client_id, a.seq`,
      ).map((a) => ({
        u: a.u ?? "",
        clientId: a.client_id,
        seq: a.seq,
        digest: a.digest,
        result: JSON.parse(a.result_json) as unknown,
        at: a.at,
      })),
    ];
    const clients = rows<{
      client_id: string;
      u: string;
      last_seq: number;
      last_used_at: number;
      created_at: number;
    }>("SELECT * FROM sync_clients ORDER BY last_used_at, client_id");
    const registrations = new Map<string, number[]>();
    for (const c2 of [...clients].sort((a, b) => a.created_at - b.created_at))
      if (c2.created_at > now - DAY)
        registrations.set(c2.u, [...(registrations.get(c2.u) ?? []), c2.created_at]);
    return c.json({
      records: rows<{ body: string }>("SELECT body FROM records ORDER BY created_v, key").map(
        (r) => JSON.parse(r.body) as StoredRecord,
      ),
      tombstones: rows<{
        key: string;
        kind: string;
        sp: string | null;
        person: string | null;
        by_u: string | null;
        deleted_at: number;
      }>("SELECT * FROM tombstones ORDER BY deleted_at, key").map((t) => ({
        key: t.key,
        kind: t.kind,
        sp: t.sp,
        person: t.person,
        by: t.by_u,
        at: t.deleted_at,
      })),
      logRows: rows<{ log: LogId; key: string; op: "put" | "del"; version: number }>(
        "SELECT log, key, op, version FROM change_log ORDER BY log, version",
      ),
      answers,
      clients: clients.map((x) => ({
        clientId: x.client_id,
        u: x.u,
        last: x.last_seq,
        seen: x.last_used_at,
      })),
      registrations: [...registrations].map(([u, at]) => ({ u, at })),
      registry: rows<{ name: string; last_rev: number }>(
        "SELECT * FROM registry ORDER BY name",
      ).map((r) => ({ id: r.name, rev: r.last_rev })),
      born: rows<{ key: string; created_v: number }>(
        "SELECT key, created_v FROM records ORDER BY key",
      ).map((r) => ({ key: r.key, version: r.created_v })),
      epochs: rows<{ log: LogId; epoch: number; start_version: number }>(
        "SELECT * FROM log_epochs ORDER BY log",
      ).map((e) => ({ log: e.log, n: e.epoch, start: e.start_version })),
    });
  });

  return app;
}
