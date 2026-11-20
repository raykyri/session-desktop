// Review round 2 of phase 2 (the web client): the event stream backs off
// when the server refuses it (too many streams open: TOO_MANY_REQUESTS) or
// a connection fails, waits at least what the refusal asks for, keeps one
// connection open at a time, and starts the backoff over once a stream
// opened.

import test from "ava";

import { FetchTransport } from "../src/client/index.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const TOO_MANY = {
  ok: false,
  error: { code: "TOO_MANY_REQUESTS", message: "Too many streams are open." },
  serverTime: 0,
};

test("the event stream backs off after refusals and failed connections, and starts over once one opens", async (t) => {
  const stop = new AbortController();
  const now = Date.now();
  // the answers to each connection, in order
  const answers: (() => Promise<Response>)[] = [
    () => Promise.resolve(json(429, TOO_MANY)),
    () => Promise.resolve(json(429, TOO_MANY, { "Retry-After": "7" })),
    () => Promise.resolve(new Response("bad gateway", { status: 502 })),
    () => Promise.reject(new TypeError("fetch failed")),
    () =>
      Promise.resolve(
        json(429, {
          ...TOO_MANY,
          error: { ...TOO_MANY.error, retryAt: new Date(now + 60_000).toISOString() },
        }),
      ),
    // a stream that opens, then ends
    () =>
      Promise.resolve(
        new Response('data: {"type":"poke","logs":[]}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    () => Promise.resolve(json(429, TOO_MANY)),
  ];
  let open = 0;
  let most = 0;
  let k = 0;
  const f: typeof fetch = () => {
    const next = answers[k++];
    if (!next) {
      stop.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    open++;
    most = Math.max(most, open);
    return next().finally(() => open--);
  };
  const waits: number[] = [];
  const tr = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: f,
    reconnectMs: 100,
    maxReconnectMs: 400,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  const events: string[] = [];
  const out = await tr.listen(
    () => ({}),
    (e) => events.push(e.type),
    stop.signal,
  );
  t.is(out, undefined);
  t.deepEqual(waits.slice(0, 7), [
    // a refusal naming no time: the base wait, then doubled each time
    100,
    // Retry-After: 7 s, more than the backoff
    7000,
    // a 502, then a connection that failed: the backoff, at most 400 ms
    400,
    400,
    // retryAt a minute away
    waits[4] ?? -1,
    // the stream opened: the base wait again
    100,
    100,
  ]);
  t.true((waits[4] ?? 0) > 50_000 && (waits[4] ?? 0) <= 60_000);
  t.deepEqual(events, ["poke"]);
  // one connection at a time
  t.is(most, 1);
});

test("a refusal's wait is capped at five minutes", async (t) => {
  const stop = new AbortController();
  let k = 0;
  const f: typeof fetch = () => {
    if (k++ > 0) {
      stop.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return Promise.resolve(json(429, TOO_MANY, { "Retry-After": "86400" }));
  };
  const waits: number[] = [];
  const tr = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: f,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  await tr.listen(
    () => ({}),
    () => undefined,
    stop.signal,
  );
  t.deepEqual(waits, [5 * 60_000]);
});
