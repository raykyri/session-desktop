// Phase 2b (the web client): the headers `FetchTransport` sends on every
// request (the web's CSRF header on a cookie POST), and the in-flight run
// text the stream carries (`onRun`).

import test from "ava";

import {
  FetchTransport,
  InProcessTransport,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type RunFrame,
  type Transport,
} from "../src/client/index.js";

import { client } from "./client-helpers.js";
import { cast } from "./helpers.js";

/** A fetch that records each request's method, path and headers. */
function recording() {
  const seen: { method: string; path: string; headers: Headers }[] = [];
  const f: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      headers: new Headers(init?.headers),
    });
    if (url.pathname === "/api/sync/events")
      return Promise.resolve(new Response(null, { status: 401 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "x" }, serverTime: 1 }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };
  return { seen, f };
}

test("FetchTransport sends its headers on every request, under the protocol's own", async (t) => {
  const { seen, f } = recording();
  const tr = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: f,
    headers: {
      "X-Requested-With": "session",
      // the transport's own headers are set after these and win
      "Content-Type": "text/plain",
      [PROTOCOL_HEADER]: "0",
    },
  });
  await tr.register().catch(() => undefined);
  await tr.push([
    {
      mutationId: "01J0000000000000000000000A",
      clientId: "c",
      seq: 1,
      name: "likes.set",
      input: {},
      protocolVersion: PROTOCOL_VERSION,
      clientTime: 1,
      queuedAt: 1,
      replaces: [],
    },
  ]);
  await tr.pull("user:mel", "cursor");
  await tr.snapshot("user:mel");
  await tr.call("research.cancelNode", {});
  await tr.listen(
    () => ({}),
    () => undefined,
    new AbortController().signal,
  );
  t.deepEqual(
    seen.map((r) => r.path),
    [
      "/api/sync/register",
      "/api/sync/write",
      "/api/sync/pull",
      "/api/sync/snapshot",
      "/api/rpc/research.cancelNode",
      "/api/sync/events",
    ],
  );
  for (const r of seen) {
    t.is(r.headers.get("X-Requested-With"), "session", r.path);
    t.is(r.headers.get(PROTOCOL_HEADER), String(PROTOCOL_VERSION), r.path);
    t.is(r.headers.get("Content-Type"), "application/json", r.path);
    t.is(r.headers.get("Authorization"), null, r.path);
  }
});

test("FetchTransport without headers sends only its own, and a bearer token when it has one", async (t) => {
  const { seen, f } = recording();
  const tr = new FetchTransport({ baseUrl: "https://s.test", fetch: f, token: () => "tok" });
  await tr.snapshot("user:mel");
  t.is(seen[0]?.headers.get("X-Requested-With"), null);
  t.is(seen[0]?.headers.get("Authorization"), "Bearer tok");
});

test("a run frame on the stream goes to the onRun listeners and changes no log", async (t) => {
  const { w, open } = cast(t);
  const inner = new InProcessTransport(w.server, { u: "mel" });
  const frames: RunFrame[] = [
    { type: "run", run: "R1", attempt: 1, seq: 1, text: "Hel" },
    { type: "run", run: "R1", attempt: 1, seq: 2, text: "lo" },
  ];
  const transport: Transport = {
    register: () => inner.register(),
    push: (e) => inner.push(e),
    pull: (l, c, o) => inner.pull(l, c, o),
    snapshot: (l, o) => inner.snapshot(l, o),
    call: (n, i) => inner.call(n, i),
    listen: (_c, onEvent) => {
      for (const f of frames) onEvent(f);
      return Promise.resolve();
    },
  };
  const mel = client(w, "mel", { transport });
  await mel.init();
  await mel.open(`space:${open}`);
  const before = mel.version();
  const got: RunFrame[] = [];
  const stop = mel.onRun((f) => got.push(f));
  const other: RunFrame[] = [];
  mel.onRun((f) => other.push(f));
  await mel.listen(new AbortController().signal);
  t.deepEqual(got, frames);
  t.deepEqual(other, frames);
  t.is(mel.version(), before);
  // a listener that stopped gets no more frames
  stop();
  await mel.listen(new AbortController().signal);
  t.is(got.length, 2);
  t.is(other.length, 4);
});
