// The phase 0 suite's `ServerFactory` over HTTP (phase 2a): each server is the
// real Hono app (`@session/server`'s production assembly) over a temp
// database on a local port, and the suite's calls go over HTTP with fetch
// (REPLICA_PROTO_SERVER=http, `npm run test:http`).
//
// What goes over HTTP: `register`, `apply` (POST /api/sync/write),
// `snapshot`, `pull`, the online calls (POST /api/rpc/<name>) and the SSE
// stream (GET /api/sync/events). Each person signs in once through
// `POST /auth/test-login` and sends its session cookie; a device sends its
// bearer token, which the adapter keeps from the `devices.token` answer. The
// suite's test-only access (the stored records, log rows, the effect
// worker, a job's answer, housekeeping and the storage scan) reads the
// server's sync half in this process, as the in-process factory does.
//
// Where HTTP cannot carry what the suite hands the in-process server, the
// adapter maps it, and nothing else:
// - an actor whose handle is no account's handle (a reserved or malformed
//   one) sends a bearer token that opens nothing: the server answers
//   UNAUTHORIZED, as `SyncServer` does for such an actor; a device the
//   adapter holds no token for does the same;
// - an envelope that JSON cannot carry (an input whose getter throws) is
//   answered INTERNAL_SERVER_ERROR without a request, as the in-process
//   server answers it;
// - envelopes, answers and reads are mapped to the prototype's shapes by the
//   in-process adapter's functions (`sync-server.ts`).

import type * as pkg from "@session/mutators";
import { isHandle } from "@session/mutators";
// the one edge to the server (ADR-1): its test assembly, for this factory
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { startTestServer } from "@session/server/test-server";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@session/sync";
import type { Answer, PullAnswer, ServerStore, SnapshotAnswer } from "@session/sync/server";

import type {
  Actor,
  ApiError,
  ServerFactory,
  ServerOptions,
  StoredRecord,
  StreamEvent,
  TestServer,
} from "../src/index.js";
import { ACTIVE_MUTATORS, packageRegistry } from "../src/switch.js";

import { copyEnvelope, noLog, readOptions, scanOf, toProto } from "./sync-server.js";

type Any = Record<string, unknown>;

/** JSON text of `v`, written with a stack: an input nested deeper than
 * `JSON.stringify`'s recursion goes is still sent as the client wrote it
 * (the server then refuses it). A getter that throws throws here. */
export function toJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  const out: string[] = [];
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string" && x.startsWith("\u0000raw:")) {
      out.push(x.slice(5));
      continue;
    }
    if (Array.isArray(x)) {
      stack.push("\u0000raw:]");
      for (let k = x.length - 1; k >= 0; k--) {
        stack.push(x[k] === undefined ? null : x[k]);
        if (k > 0) stack.push("\u0000raw:,");
      }
      stack.push("\u0000raw:[");
    } else if (x !== null && typeof x === "object") {
      const entries = Object.entries(x).filter(([, y]) => y !== undefined);
      stack.push("\u0000raw:}");
      for (let k = entries.length - 1; k >= 0; k--) {
        const [key, y] = entries[k] as [string, unknown];
        stack.push(y);
        stack.push(`\u0000raw:${JSON.stringify(key)}:`);
        if (k > 0) stack.push("\u0000raw:,");
      }
      stack.push("\u0000raw:{");
    } else out.push(JSON.stringify(x) ?? "null");
  }
  return out.join("");
}

/** A token no device has: an actor the server must not sign in. */
const NOBODY = "Bearer not-a-device-token";

export function httpFactory(): ServerFactory {
  return (o: ServerOptions): TestServer => {
    const jobs: { kind: string; id: string }[] = [];
    const { deps, ready } = startTestServer({
      sync: {
        clock: o.clock,
        ...(o.random ? { random: o.random } : {}),
        registry: packageRegistry(o.mutators ?? ACTIVE_MUTATORS),
        jobs: { start: (j) => void jobs.push({ kind: j.kind, id: j.id }) },
        ...(o.failEffect
          ? {
              failEffect: (e: pkg.Effect, n: number) =>
                (o.failEffect as NonNullable<typeof o.failEffect>)(e as never, n),
            }
          : {}),
      },
    });
    const server = deps.sync;
    const store: ServerStore = server.store;
    const cookies = new Map<string, Promise<string | null>>();
    const tokens = new Map<string, string>();

    /** A session cookie for handle `u` (test-login), or null when `u` is no
     * handle an account can have. */
    const cookieOf = (u: string): Promise<string | null> => {
      let c = cookies.get(u);
      if (!c) {
        c = (async () => {
          if (!isHandle(u) || u !== u.toLowerCase()) return null;
          const { origin } = await ready;
          const res = await fetch(`${origin}/auth/test-login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Requested-With": "session" },
            body: JSON.stringify({ login: u }),
          });
          const user = (await res.json()) as { handle?: string };
          // a login whose handle the server made otherwise ("null" → "null-1")
          if (user.handle !== u) return null;
          const set = res.headers.get("set-cookie") ?? "";
          return /session=([^;]+)/.exec(set)?.[1] ?? null;
        })();
        cookies.set(u, c);
      }
      return c;
    };

    /** The headers that sign `actor` in. */
    const authOf = async (actor: (Actor & { device?: string }) | null) => {
      // signed out: no credential, and the header the CSRF guard asks of a
      // browser's request
      if (actor === null) return { "X-Requested-With": "session" };
      if (actor.device !== undefined) {
        const t = tokens.get(actor.device);
        return { Authorization: t ? `Bearer ${t}` : NOBODY };
      }
      const c = await cookieOf(actor.u);
      return c === null
        ? { Authorization: NOBODY }
        : { Cookie: `session=${c}`, "X-Requested-With": "session" };
    };

    const post = async (
      path: string,
      actor: (Actor & { device?: string }) | null,
      body: string,
    ): Promise<Any> => {
      const { origin } = await ready;
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          ...(await authOf(actor)),
        },
        body,
      });
      return (await res.json()) as Any;
    };

    return {
      async register(a) {
        const r = await post("/api/sync/register", a, "{}");
        return r["ok"] === true
          ? { ok: true, clientId: r["clientId"] as string }
          : { ok: false, error: { ...(r["error"] as ApiError) } };
      },
      async apply(a, e) {
        let body: string;
        try {
          body = toJson(copyEnvelope(e));
        } catch {
          return { ok: false, error: { code: "INTERNAL_SERVER_ERROR", message: "" } };
        }
        return toProto((await post("/api/sync/write", a, body)) as unknown as Answer);
      },
      async snapshot(a, log, opts) {
        const s = (await post(
          "/api/sync/snapshot",
          a,
          JSON.stringify({ log, ...readOptions(opts) }),
        )) as unknown as SnapshotAnswer;
        if (s.ok === false) return { records: [], cursor: noLog(log), lastSeq: null };
        return { records: s.records as never, cursor: s.cursor, lastSeq: s.lastSeq };
      },
      async pull(a, log, cursor, opts) {
        const p = (await post(
          "/api/sync/pull",
          a,
          JSON.stringify({ log, cursor, ...readOptions(opts) }),
        )) as unknown as PullAnswer;
        if (p.ok === false)
          return cursor === noLog(log) ? { changes: [], cursor, lastSeq: null } : { resync: true };
        if ("resync" in p) return { resync: true };
        return { changes: p.changes as never, cursor: p.cursor, lastSeq: p.lastSeq };
      },
      dump: () => server.records() as unknown as ReadonlyMap<string, StoredRecord>,
      logRows: (log) => server.logRows(log),
      jobs: () => jobs,
      work: () => server.work(),
      finishJob: (key, text) => server.finishJob(key, text),
      online: {
        async call(a, name, input) {
          let body: string;
          try {
            body = toJson(input ?? {});
          } catch {
            return { ok: false, error: { code: "BAD_REQUEST", message: "" } };
          }
          const r = await post(`/api/rpc/${encodeURIComponent(name)}`, a, body);
          if (r["ok"] === true) {
            const result = r["result"] as Any | null;
            // a device's token, for the calls it makes as that device
            if (name === "devices.token" && result && typeof result["token"] === "string")
              tokens.set(result["device"] as string, result["token"]);
            return { ok: true, result };
          }
          const err = r["error"] as ApiError;
          const e: ApiError = { code: err.code, message: err.message };
          if (err.issues) e.issues = [...err.issues];
          return { ok: false, error: e };
        },
        stream(a, cursors) {
          const ac = new AbortController();
          let text = "";
          const pump = (async () => {
            const { origin } = await ready;
            try {
              const res = await fetch(`${origin}/api/sync/events`, {
                headers: {
                  [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
                  Accept: "text/event-stream",
                  "Last-Event-ID": JSON.stringify(cursors),
                  ...(await authOf(a)),
                },
                signal: ac.signal,
              });
              if (!res.body) return;
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                text += dec.decode(r.value as Uint8Array);
              }
            } catch {
              // closed
            }
          })();
          // a request and its events cross a socket: wait until the stream
          // has been quiet a moment
          const settle = async () => {
            let seen = -1;
            for (let k = 0; k < 50 && seen !== text.length; k++) {
              seen = text.length;
              await new Promise((r) => setTimeout(r, 15));
            }
          };
          const parse = (): StreamEvent[] =>
            [...text.matchAll(/event: (poke|run)\n(?:id: .*\n)?data: (.*)\n\n/g)].map(
              (m) => JSON.parse(m[2] ?? "{}") as StreamEvent,
            );
          return {
            events: async () => {
              await settle();
              return parse();
            },
            close: async () => {
              ac.abort();
              await pump;
            },
          };
        },
        tick() {
          let f = () => {};
          const stop = server.startHousekeeping({
            setInterval: (g) => (f = g),
            clearInterval: () => {},
          });
          f();
          stop();
        },
      },
      scanStorage: () => scanOf(server, store, jobs),
    };
  };
}
