// Enforces maximum response body byte limits on oEmbed, syndication,
// embed images, and shared HTTP reader responses (`src/net/readCapped.ts`).

import { embeds } from "@session/db";
import test from "ava";

import { MAX_EMBED_BYTES, embedHash } from "../src/embeds/storage.js";
import { MAX_OEMBED_RESPONSE_BYTES, fetchTweetOembed } from "../src/journal/oembed.js";
import { MAX_TWEET_RESPONSE_BYTES, fetchTweetJson } from "../src/journal/tweets.js";
import { ResponseTooLargeError, readCapped } from "../src/net/readCapped.js";

import { createHarness } from "./helpers.js";

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

test("an oversized oEmbed body is aborted at the byte cap", async (t) => {
  const body = meteredBody(8 * 1024 * 1024);
  const doFetch: typeof globalThis.fetch = () => Promise.resolve(new Response(body.stream));
  await t.throwsAsync(fetchTweetOembed(doFetch, "1599367266448994304"), {
    message: /exceeds the maximum allowed size/,
  });
  t.true(body.pulled() <= MAX_OEMBED_RESPONSE_BYTES + CHUNK, `read ${body.pulled()} bytes`);
});

test("an oversized syndication body is aborted at the byte cap", async (t) => {
  const body = meteredBody(8 * 1024 * 1024);
  const doFetch: typeof globalThis.fetch = () => Promise.resolve(new Response(body.stream));
  await t.throwsAsync(fetchTweetJson(doFetch, "1599367266448994304", "4c2mmul6mnh"));
  t.true(body.pulled() <= MAX_TWEET_RESPONSE_BYTES + CHUNK, `read ${body.pulled()} bytes`);
});

test("an embed image over the cap is not stored and is read only to the cap", async (t) => {
  const image = "https://pbs.twimg.com/profile_images/1/large.jpg";
  const body = meteredBody(MAX_EMBED_BYTES * 4);
  const harness = createHarness(t, {
    fetch: () =>
      Promise.resolve(new Response(body.stream, { headers: { "Content-Type": "image/jpeg" } })),
  });
  const hash = embedHash(image);
  embeds.register(harness.db, { hash, sourceUrl: image });
  const response = await harness.request(`/embeds/${hash}`);
  t.is(response.status, 404);
  t.true(body.pulled() <= MAX_EMBED_BYTES + CHUNK, `read ${body.pulled()} bytes`);
  t.is(embeds.get(harness.db, hash)?.storedAt, null);
});
