// Enforces maximum response body byte limits on the shared HTTP reader
// (`src/net/readCapped.ts`).

import test from "ava";

import { ResponseTooLargeError, readCapped } from "../src/net/readCapped.js";

const CHUNK = 64 * 1024;

/** A body of `total` bytes produced one chunk per pull, with no
 * `content-length`, recording how much of it was read. */
function meteredBody(total: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (cancelled || pulled >= total) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK, total - pulled);
        pulled += size;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

test("the reader stops at the cap and cancels the body", async (t) => {
  const body = meteredBody(10 * 1024 * 1024);
  await t.throwsAsync(readCapped(new Response(body.stream), 256 * 1024), {
    instanceOf: ResponseTooLargeError,
  });
  t.true(body.pulled() <= 256 * 1024 + CHUNK, `read ${body.pulled()} bytes`);
});

test("the reader truncates to the cap when overflow is set to truncate", async (t) => {
  const body = meteredBody(1024 * 1024);
  const read = await readCapped(new Response(body.stream), 100_000, { overflow: "truncate" });
  t.is(read.bytes.byteLength, 100_000);
  t.true(read.truncated);
  t.true(body.pulled() <= 100_000 + CHUNK);
  const small = await readCapped(new Response("short"), 100_000);
  t.is(new TextDecoder().decode(small.bytes), "short");
  t.false(small.truncated);
});

test("a declared content-length over the cap is rejected before reading the body", async (t) => {
  const body = meteredBody(1024 * 1024);
  const response = new Response(body.stream, { headers: { "content-length": "1048576" } });
  await t.throwsAsync(readCapped(response, 1000), { instanceOf: ResponseTooLargeError });
  t.is(body.pulled(), 0);
});
