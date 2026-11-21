// The event stream's memory over a long-lived connection (`runbooks/
// load-check.md`): @hono/node-server before 2.1.8 chained a pending promise
// per chunk written to a streamed response, freed only when a write waited
// for a drain or the response ended, so a stream whose socket kept up grew
// with every event it carried. This writes 50,000 events
// to one stream over a real socket and measures the heap after garbage
// collection (the suite runs Node with `--expose-gc`).

import { serve, type ServerType } from "@hono/node-server";
import test from "ava";

import { closeServer } from "../src/main.js";

import { createHarness } from "./helpers.js";
import { Person } from "./syncHttp.js";

const gc = (globalThis as { gc?: () => void }).gc;

const heapAfterGc = () => {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
};

test("50,000 events on one stream leave the heap flat after garbage collection", async (t) => {
  if (!gc) return t.fail("run with --expose-gc");
  const h = createHarness(t);
  const p = new Person(h, h.addUser("reader"));
  await p.register();
  const log = "user:reader";
  const cursor = (await p.snapshot(log)).cursor;
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  t.teardown(() => closeServer(server, 100));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/events?clientId=${p.clientId}`, {
    headers: {
      Origin: "http://localhost:8787",
      "Session-Protocol": "4",
      Cookie: `session=${p.cookie}`,
      "Session-Cursors": JSON.stringify({ [log]: cursor }),
    },
  });
  t.is(res.status, 200);
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (!reader) return t.fail("no body");
  let received = 0;
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += decoder.decode(value).split("event: run.delta").length - 1;
    }
  })();
  const data = { run: "r", text: "x".repeat(100) };
  let sent = 0;
  // a few events at a time, each lot read before the next, as a paced run
  // delivers them: the socket's buffer never fills, so the server's writes
  // never wait for a drain
  const send = async (n: number) => {
    for (let k = 0; k < n; k += 10) {
      for (let i = 0; i < 10; i += 1) h.sync.hub.ephemeral(log, "run.delta", data, () => true);
      sent += 10;
      while (received < sent) await new Promise((r) => setImmediate(r));
    }
  };
  await send(5_000);
  const before = heapAfterGc();
  await send(45_000);
  const after = heapAfterGc();
  t.is(h.sync.hub.size(), 1, "the stream stayed open");
  const growth = (after - before) / 1024 / 1024;
  t.log(
    `heap after GC: ${(before / 1048576).toFixed(1)} MB, then ${(after / 1048576).toFixed(1)} MB`,
  );
  t.true(growth < 2, `the heap grew ${growth.toFixed(1)} MB over 45,000 events`);
  await reader.cancel();
});
