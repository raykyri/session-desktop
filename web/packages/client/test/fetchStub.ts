// A recording stand-in for the server (phase 2b: the shell's plain routes and
// the sync routes in place of tRPC). A route is "METHOD /path"; its answer is
// a JSON body, a function of the request body, or a `Response`.

import type { StoredRecord } from "@session/sync/client";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

/** A JSON body, a function of the request body, or a `Response`. */
export type Answer = unknown;

export interface FetchStub {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  routes: Map<string, Answer>;
  /** The records a snapshot of each log answers. */
  logs: Map<string, StoredRecord[]>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function createFetchStub(routes: Record<string, Answer> = {}): FetchStub {
  const stub: FetchStub = {
    fetch: null as unknown as typeof fetch,
    calls: [],
    routes: new Map(Object.entries(routes)),
    logs: new Map(),
  };
  const now = () => Date.parse("2026-11-16T10:00:00Z");
  stub.fetch = (input, init) => Promise.resolve(answer(input, init));
  const answer = (input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Response => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://localhost",
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const text = typeof init?.body === "string" ? init.body : "";
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    stub.calls.push({ method, path: url.pathname, body, headers: new Headers(init?.headers) });
    const key = `${method} ${url.pathname}`;
    if (stub.routes.has(key)) {
      const a = stub.routes.get(key);
      const out = typeof a === "function" ? (a as (b: unknown) => unknown)(body) : a;
      if (out instanceof Response) return out;
      return json(200, out);
    }
    // the sync routes, as an empty server answers them
    switch (key) {
      case "POST /api/sync/register":
        return json(200, { ok: true, clientId: "c1", lastSeq: 0, serverTime: now() });
      case "POST /api/sync/snapshot": {
        const log = (body as { log: string }).log;
        const records = (stub.logs.get(log) ?? []).map((record) => ({
          key: `${record.kind}:${(record as { id?: string }).id ?? ""}`,
          record,
        }));
        return json(200, { ok: true, records, cursor: `k:${log}`, lastSeq: 0, serverTime: now() });
      }
      case "POST /api/sync/pull":
        return json(200, {
          ok: true,
          changes: [],
          cursor: (body as { cursor: string }).cursor,
          lastSeq: 0,
          serverTime: now(),
        });
      case "GET /api/spaces":
        return json(200, { spaces: [], stats: [], serverTime: now() });
    }
    return json(404, { error: { code: "NOT_FOUND", message: `no route ${key}` } });
  };
  return stub;
}
