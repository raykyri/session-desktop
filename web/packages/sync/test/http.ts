// A minimal HTTP front for the server half, as a `fetch` function: the
// routes `FetchTransport` calls, a bearer device token or a fixed browser
// session, the protocol version header (426 UPDATE_REQUIRED below the
// minimum), and the SSE stream. Phase 2's real server does this in its HTTP
// framework; this one is for the transport's tests.

import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  sseResponse,
  type Actor,
  type SyncServer,
} from "../src/server/index.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function httpFetch(
  server: SyncServer,
  o: { browser?: Actor | null; minProtocol?: () => number } = {},
): typeof fetch {
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const auth = req.headers.get("Authorization");
    const actor = auth?.startsWith("Bearer ")
      ? server.online.authenticate(auth.slice(7))
      : (o.browser ?? null);
    const v = Number(req.headers.get(PROTOCOL_HEADER));
    if (!(v >= (o.minProtocol?.() ?? MIN_PROTOCOL_VERSION)))
      return json(426, {
        ok: false,
        error: { code: "UPDATE_REQUIRED", message: "Update Session." },
        serverTime: Date.now(),
      });
    if (req.method === "GET" && url.pathname === "/api/sync/events")
      return sseResponse(server, req, actor, { setInterval: () => 0, clearInterval: () => {} });
    const raw = await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    switch (url.pathname) {
      case "/api/sync/register":
        return json(200, server.register(actor));
      case "/api/sync/write":
        return json(200, server.apply(actor, body, raw.length));
      case "/api/sync/pull": {
        const { log, cursor, ...rest } = body;
        return json(200, server.pull(actor, log as never, cursor as string, rest));
      }
      case "/api/sync/snapshot": {
        const { log, ...rest } = body;
        return json(200, server.snapshot(actor, log as never, rest));
      }
    }
    if (url.pathname.startsWith("/api/rpc/"))
      return json(200, server.call(actor, decodeURIComponent(url.pathname.slice(9)), body));
    return json(404, { ok: false, error: { code: "NOT_FOUND", message: "no route" } });
  };
  return ((input: string | URL | Request, init?: RequestInit) =>
    handle(new Request(input, init))) as typeof fetch;
}
