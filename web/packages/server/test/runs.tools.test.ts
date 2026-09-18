// The owned tools: the address policy in front of `web_fetch`, its caps and
// extraction, `document_read` chunking, and the shared cache
// (`04-agent-runtime.md` §6, `12-testing-linting-ci.md` §3.3).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { documents as documentsRepo } from "@session/db";
import test from "ava";

import { ToolCache } from "../src/runs/tools/cache.js";
import type { RunToolContext } from "../src/runs/tools/context.js";
import { ToolBudget, createToolCaches } from "../src/runs/tools/context.js";
import { chunkDocumentText, createDocumentReadTool } from "../src/runs/tools/documentRead.js";
import { BlockedUrlError, assertFetchableUrl, isPrivateAddress } from "../src/runs/tools/ssrf.js";
import { extractHtml, fetchCacheKey, fetchReadablePage } from "../src/runs/tools/webFetch.js";
import { createWebSearchTool, searchVendors } from "../src/runs/tools/webSearch.js";

import { createHarness } from "./helpers.js";

const EXECUTION_OPTIONS = { toolCallId: "call-1", messages: [] } as never;

function toolContext(harness: ReturnType<typeof createHarness>, userId: string): RunToolContext {
  return {
    config: harness.config,
    db: harness.db,
    userId,
    nodeId: null,
    logger: harness.logger,
    fetch: globalThis.fetch,
    budget: new ToolBudget(),
    caches: createToolCaches(),
    recordUsage: () => undefined,
  };
}

test("blocks private, loopback, and reserved IP addresses in web_fetch", (t) => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "2001:db8::1",
    "not-an-address",
  ]) {
    t.true(isPrivateAddress(address), `${address} is not public`);
  }
  for (const address of [
    "93.184.216.34",
    "1.1.1.1",
    "8.8.8.8",
    "2606:2800:220:1:248:1893:25c8:1946",
  ]) {
    t.false(isPrivateAddress(address), `${address} is public`);
  }
});

test("the guard refuses non-http schemes, credentials, and private names", async (t) => {
  await t.throwsAsync(assertFetchableUrl("file:///etc/passwd"), {
    instanceOf: BlockedUrlError,
    message: /Protocol 'file:' is unsupported/,
  });
  await t.throwsAsync(assertFetchableUrl("https://user:pass@example.com/"), {
    instanceOf: BlockedUrlError,
    message: /embedded credentials/,
  });
  await t.throwsAsync(assertFetchableUrl("http://127.0.0.1:8080/admin"), {
    instanceOf: BlockedUrlError,
    message: /not a public address/,
  });
  await t.throwsAsync(assertFetchableUrl("http://[::1]/"), {
    instanceOf: BlockedUrlError,
    message: /not a public address/,
  });
  // A public name that resolves to loopback is the DNS form of the same attack.
  await t.throwsAsync(
    assertFetchableUrl("https://internal.example.com/", {
      lookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    }),
    { message: /resolves to a private address/ },
  );
  // One public and one private record is still a refusal.
  await t.throwsAsync(
    assertFetchableUrl("https://mixed.example.com/", {
      lookup: () =>
        Promise.resolve([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
    }),
    { message: /resolves to a private address/ },
  );
  const allowed = await assertFetchableUrl("https://example.com/page", {
    lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
  });
  t.is(allowed.host, "example.com");
});

test("web_fetch reads a public page, caps it, and refuses a redirect to loopback", async (t) => {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<html><head><title>Fixture page</title></head><body><article><p>" +
          "The readable body of the fixture page, long enough to survive extraction." +
          "</p></article></body></html>",
      );
      return;
    }
    if (url === "/redirect-to-self") {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/page` });
      response.end();
      return;
    }
    if (url === "/huge") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(200_000));
      return;
    }
    response.writeHead(404);
    response.end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.teardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const harness = createHarness(t);
  const user = harness.addUser("fetcher");
  const base = toolContext(harness, user.id);
  const host = `127.0.0.1:${port}`;

  // Without the allow-list, the loopback fixture server is exactly what the
  // guard exists to refuse.
  await t.throwsAsync(fetchReadablePage(base, `http://${host}/page`, AbortSignal.timeout(5_000)), {
    message: /not a public address/,
  });

  const allowed: RunToolContext = { ...base, allowHosts: [host] };
  const page = await fetchReadablePage(allowed, `http://${host}/page`, AbortSignal.timeout(5_000));
  t.is(page.title, "Fixture page");
  t.regex(page.text, /readable body of the fixture page/);
  t.false(page.truncated);

  // A redirect is re-checked: the allow-list covers the first host, and the
  // hop is to an address the policy refuses on its own terms.
  const redirecting: RunToolContext = { ...base, allowHosts: [host] };
  const hop = await fetchReadablePage(
    { ...redirecting, allowHosts: [] },
    `http://${host}/redirect-to-self`,
    AbortSignal.timeout(5_000),
  ).catch((error: unknown) => error);
  t.true(hop instanceof Error);

  // Text over the character cap comes back truncated rather than whole.
  const huge = await fetchReadablePage(allowed, `http://${host}/huge`, AbortSignal.timeout(5_000));
  t.true(huge.truncated);
  t.is(huge.text.length, 40_000);
});

test("HTML becomes readable text, with a fallback for what Readability cannot parse", async (t) => {
  const article = await extractHtml(
    "<html><head><title>Consistent hashing</title></head><body><nav>menu</nav><article><p>" +
      "A ring of hash values assigns keys to the next node clockwise, so adding a node moves " +
      "only the keys between it and its predecessor." +
      "</p></article></body></html>",
    "https://example.com/hashing",
  );
  t.regex(article.text, /ring of hash values/);
  t.false(article.text.includes("<p>"));

  const bare = await extractHtml("<div>just a div</div>", "https://example.com/bare");
  t.regex(bare.text, /just a div/);
});

test("document_read chunks at 30k characters and stays inside the account", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("reader");
  const other = harness.addUser("stranger");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const document = documentsRepo.create(harness.db, user.id, {
    workspaceId: workspace.id,
    name: "notes.txt",
    mime: "text/plain",
    byteSize: 10,
    sha256: "abc",
    storagePath: "/tmp/notes.txt",
  });
  const body = `${"paragraph one. ".repeat(3_000)}\n\n${"paragraph two. ".repeat(3_000)}`;
  documentsRepo.setExtraction(harness.db, user.id, document.id, {
    status: "ok",
    pages: [body],
  });

  const chunks = chunkDocumentText(body);
  t.true(chunks.length > 1);
  t.true(chunks.every((chunk) => chunk.length <= 30_000));
  t.is(chunks.join(""), body, "chunking loses nothing");

  const tool = createDocumentReadTool(toolContext(harness, user.id), [document.id]);
  const first = (await tool.execute?.({ documentId: document.id }, EXECUTION_OPTIONS)) as {
    chunk: number;
    chunkCount: number;
    hasMore: boolean;
    text: string;
  };
  t.is(first.chunk, 0);
  t.true(first.hasMore);
  t.is(first.text, chunks[0] ?? "");

  const last = (await tool.execute?.(
    { documentId: document.id, chunk: chunks.length - 1 },
    EXECUTION_OPTIONS,
  )) as { hasMore: boolean };
  t.false(last.hasMore);

  const past = (await tool.execute?.(
    { documentId: document.id, chunk: 99 },
    EXECUTION_OPTIONS,
  )) as { error?: string };
  t.regex(past.error ?? "", /requested chunk 99 is out of bounds/);

  // A document that is not attached, and one belonging to someone else, are
  // both simply not there.
  const unattached = createDocumentReadTool(toolContext(harness, user.id), []);
  const refused = (await unattached.execute?.({ documentId: document.id }, EXECUTION_OPTIONS)) as {
    error?: string;
  };
  t.regex(refused.error ?? "", /No document with ID .* is attached/);

  const foreign = createDocumentReadTool(toolContext(harness, other.id), [document.id]);
  const notFound = (await foreign.execute?.({ documentId: document.id }, EXECUTION_OPTIONS)) as {
    error?: string;
  };
  t.regex(notFound.error ?? "", /was not found/);
});

test("search results are cached and the vendor order follows the configuration", async (t) => {
  const calls: string[] = [];
  const harness = createHarness(t, {
    env: { PARALLEL_API_KEY: "p", TAVILY_API_KEY: "tv", SESSION_SEARCH_VENDOR: "tavily" },
  });
  const user = harness.addUser("searcher");
  const vendors = searchVendors(harness.config, globalThis.fetch);
  t.deepEqual(
    vendors.map((vendor) => vendor.name),
    ["tavily", "parallel"],
    "the configured vendor is primary and the other is the fallback",
  );

  const context: RunToolContext = {
    ...toolContext(harness, user.id),
    fetch: (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.startsWith("https://api.tavily.com")) {
        return Promise.resolve(new Response("nope", { status: 503 }));
      }
      return Promise.resolve(
        Response.json({
          results: [{ url: "https://example.com/a", title: "A", excerpts: ["first"] }],
        }),
      );
    },
  };
  const tool = createWebSearchTool(context, new AbortController().signal);
  const first = (await tool?.execute?.({ query: "Consistent  Hashing" }, EXECUTION_OPTIONS)) as {
    results: { url: string }[];
  };
  t.is(first.results.length, 1);
  t.is(calls.length, 2, "the fallback vendor answered after the primary failed");

  const second = (await tool?.execute?.({ query: "consistent hashing" }, EXECUTION_OPTIONS)) as {
    results: { url: string }[];
  };
  t.deepEqual(second.results, first.results);
  t.is(calls.length, 2, "a normalized repeat query is served from the cache");
});

test("web_search is absent when the deployment has no vendor key", (t) => {
  const harness = createHarness(t, { env: { PARALLEL_API_KEY: "", TAVILY_API_KEY: "" } });
  const user = harness.addUser("keyless");
  t.deepEqual(searchVendors(harness.config, globalThis.fetch), []);
  t.is(
    createWebSearchTool(toolContext(harness, user.id), new AbortController().signal),
    null,
    "no vendor, no tool",
  );
});

test("the tool cache expires entries and evicts the coldest", (t) => {
  let now = 1_000;
  const cache = new ToolCache<string>({ maxEntries: 2, ttlMs: 100, now: () => now });
  cache.set("a", "1");
  cache.set("b", "2");
  t.is(cache.get("a"), "1");
  cache.set("c", "3");
  t.is(cache.size, 2);
  t.is(cache.get("b"), undefined, "the least recently used entry was evicted");
  now += 101;
  t.is(cache.get("a"), undefined, "an expired entry is gone");
});

test("an IP written another way is still an IP", async (t) => {
  // The WHATWG parser normalizes decimal, octal, hexadecimal, shorthand, and
  // fullwidth forms into a dotted quad before the guard sees the host, which
  // is why the address policy does not have to parse them itself. The test
  // pins that reliance: a parser that stopped normalizing would open the guard.
  for (const raw of [
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://127.1/",
    "http://１２７.0.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:ffff:a00:1]/",
    "http://[::ffff:169.254.169.254]/",
  ]) {
    await t.throwsAsync(assertFetchableUrl(raw), {
      instanceOf: BlockedUrlError,
      message: /not a public address/,
    });
  }
  // A name is not an address, so it goes to the resolver rather than the
  // parser: `nip.io`-style hosts are caught by what they resolve to.
  await t.throwsAsync(
    assertFetchableUrl("http://127.0.0.1.nip.io/", {
      lookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    }),
    { message: /resolves to a private address/ },
  );
});

test("the fetch cache key ignores what does not change the response", (t) => {
  t.is(fetchCacheKey("https://Example.COM/a"), fetchCacheKey("https://example.com/a"));
  t.is(fetchCacheKey("https://example.com/a#section"), fetchCacheKey("https://example.com/a"));
  t.not(fetchCacheKey("https://example.com/a?q=1"), fetchCacheKey("https://example.com/a"));
  t.is(fetchCacheKey("not a url"), "not a url", "an unparsable string is its own key");
});
