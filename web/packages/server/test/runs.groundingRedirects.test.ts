// Grounding redirect links resolve to the pages they stand for before the
// mapper commits them (`04-agent-runtime.md` §6.2).

import type { TextStreamPart, ToolSet } from "ai";
import test from "ava";

import { createLogger } from "../src/logger.js";
import {
  createGroundingRedirectResolver,
  isGroundingRedirectUrl,
  resolveGroundingRedirects,
} from "../src/runs/groundingRedirects.js";

const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFg=";
const REDIRECT_2 = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBBBBBBB=";
const PAGE = "https://podcasts.apple.com/us/podcast/2035/id1832694022";

const logger = createLogger({ level: "error", write: () => undefined });

/** A fetch that answers each redirect link with a 302 and counts its calls. */
function redirecting(targets: Record<string, string | number>) {
  const calls: { url: string; method: string | undefined }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method });
    const target = targets[url];
    if (target === undefined) {
      return Promise.reject(new Error(`unexpected fetch of ${url}`));
    }
    if (typeof target === "number") {
      return Promise.resolve(new Response(null, { status: target }));
    }
    return Promise.resolve(new Response(null, { status: 302, headers: { location: target } }));
  };
  return { fetch, calls };
}

test("only https links on Google's grounding redirect path count", (t) => {
  t.true(isGroundingRedirectUrl(REDIRECT));
  t.false(isGroundingRedirectUrl(PAGE));
  t.false(
    isGroundingRedirectUrl("http://vertexaisearch.cloud.google.com/grounding-api-redirect/x"),
  );
  t.false(isGroundingRedirectUrl("https://vertexaisearch.cloud.google.com/other/x"));
  t.false(isGroundingRedirectUrl("not a url"));
});

test("a redirect link resolves with one HEAD and is memoized", async (t) => {
  const { fetch, calls } = redirecting({ [REDIRECT]: PAGE });
  const resolver = createGroundingRedirectResolver({ fetch, logger });
  t.is(await resolver.resolve(REDIRECT), PAGE);
  t.is(await resolver.resolve(REDIRECT), PAGE);
  t.deepEqual(calls, [{ url: REDIRECT, method: "HEAD" }]);
  t.is(await resolver.resolve(PAGE), PAGE, "a plain link is not fetched");
  t.is(calls.length, 1);
});

test("a link that does not redirect, errors, or chains into itself is kept", async (t) => {
  const kept = createGroundingRedirectResolver({
    fetch: redirecting({ [REDIRECT]: 200 }).fetch,
    logger,
  });
  t.is(await kept.resolve(REDIRECT), REDIRECT);

  const failing = createGroundingRedirectResolver({
    fetch: () => Promise.reject(new Error("network down")),
    logger,
  });
  t.is(await failing.resolve(REDIRECT), REDIRECT);

  const looping = createGroundingRedirectResolver({
    fetch: redirecting({ [REDIRECT]: REDIRECT_2, [REDIRECT_2]: REDIRECT }).fetch,
    logger,
  });
  t.is(await looping.resolve(REDIRECT), REDIRECT);
});

test("source parts and grounding chunks carry the resolved page", async (t) => {
  const { fetch, calls } = redirecting({ [REDIRECT]: PAGE });
  const resolver = createGroundingRedirectResolver({ fetch, logger });

  const source = {
    type: "source",
    sourceType: "url",
    id: "s0",
    url: REDIRECT,
    title: "podcasts.apple.com",
  } as TextStreamPart<ToolSet>;
  const resolvedSource = await resolveGroundingRedirects(source, resolver);
  t.is(
    resolvedSource.type === "source" && resolvedSource.sourceType === "url"
      ? resolvedSource.url
      : null,
    PAGE,
  );

  const step = {
    type: "finish-step",
    finishReason: "stop",
    providerMetadata: {
      google: {
        groundingMetadata: {
          webSearchQueries: ["2035 podcast"],
          groundingChunks: [
            { web: { uri: REDIRECT, title: "podcasts.apple.com" } },
            { web: { uri: "https://esa.example/debris", title: "esa.example" } },
            { web: {} },
          ],
        },
      },
    },
  } as unknown as TextStreamPart<ToolSet>;
  const resolvedStep = await resolveGroundingRedirects(step, resolver);
  const grounding = (
    resolvedStep as unknown as { providerMetadata: { google: { groundingMetadata: unknown } } }
  ).providerMetadata.google.groundingMetadata;
  t.deepEqual(grounding, {
    webSearchQueries: ["2035 podcast"],
    groundingChunks: [
      { web: { uri: PAGE, title: "podcasts.apple.com" } },
      { web: { uri: "https://esa.example/debris", title: "esa.example" } },
      { web: {} },
    ],
  });
  t.is(calls.length, 1, "the source part and the chunk share one lookup");

  const delta = { type: "text-delta", id: "t0", text: "hi" } as TextStreamPart<ToolSet>;
  t.is(
    await resolveGroundingRedirects(delta, resolver),
    delta,
    "other parts pass through untouched",
  );
});
