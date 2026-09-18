// Rendered document pages on the artifact origin
// (`11-artifacts-and-browser.md` §2).

import { createHash } from "node:crypto";

import type { DocumentInfo } from "@session/shared";
import test from "ava";

import { FONT_FILES, readFont } from "../src/artifacts/fonts.js";
import {
  PREVIEW_SCROLL_SCRIPT,
  escapeHtml,
  parseBodyFont,
  renderMarkdown,
  renderedPageContentSecurityPolicy,
} from "../src/artifacts/page.js";
import { renderKind } from "../src/artifacts/route.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness } from "./helpers.js";

const ARTIFACT_HOST = new URL(ARTIFACT_ORIGIN).host;

/** Uploads one document and mints a preview token for it. */
async function previewPath(
  harness: ReturnType<typeof createHarness>,
  file: { name: string; type: string; body: string },
): Promise<string> {
  const user = harness.addUser(`uploader-${file.name}`);
  const cookie = harness.signIn(user);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const form = new FormData();
  form.set("workspaceId", workspace.id);
  form.append("files", new File([file.body], file.name, { type: file.type }));
  const uploaded = await harness.request("/uploads", { method: "POST", body: form, cookie });
  const [document] = (await uploaded.json()) as DocumentInfo[];
  const minted = await caller.artifacts.mintToken({ documentId: document?.id ?? "" });
  return new URL(minted.url).pathname;
}

async function get(
  harness: ReturnType<typeof createHarness>,
  path: string,
  host = ARTIFACT_HOST,
): Promise<Response> {
  return harness.app.request(path, { headers: { Host: host } });
}

test("a Markdown document is rendered into the styled page", async (t) => {
  const harness = createHarness(t);
  const path = await previewPath(harness, {
    name: "notes.md",
    type: "text/markdown",
    body: "# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
  });

  const served = await get(harness, path);
  t.is(served.status, 200);
  t.is(served.headers.get("content-type"), "text/html; charset=utf-8");
  t.is(served.headers.get("x-content-type-options"), "nosniff");
  t.is(served.headers.get("referrer-policy"), "no-referrer");
  t.is(served.headers.get("cache-control"), "private, no-store");
  // Rendering produces a different entity from the stored bytes, so no range
  // into the source could mean anything.
  t.is(served.headers.get("accept-ranges"), "none");
  const html = await served.text();
  t.true(html.startsWith("<!doctype html>"));
  t.true(html.includes("<h1>Title</h1>"));
  t.true(html.includes("<table>"));
  t.true(html.includes("<title>notes.md</title>"));

  // `?raw=1` is the opt-out, and it is the path that keeps `Range` working.
  const raw = await get(harness, `${path}?raw=1`);
  t.is(raw.headers.get("content-type"), "text/plain; charset=utf-8");
  t.is(raw.headers.get("accept-ranges"), "bytes");
  t.true((await raw.text()).startsWith("# Title"));
});

test("the page CSP allows exactly the script the page carries", async (t) => {
  const harness = createHarness(t);
  const path = await previewPath(harness, {
    name: "notes.md",
    type: "text/markdown",
    body: "hello",
  });
  const served = await get(harness, path);
  const html = await served.text();

  // The hash is derived here from the bytes that were actually served, so the
  // test fails if the inline bridge and the policy ever drift apart.
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  t.is(inline, PREVIEW_SCROLL_SCRIPT);
  const digest = createHash("sha256")
    .update(inline ?? "", "utf8")
    .digest("base64");
  const policy = served.headers.get("content-security-policy") ?? "";
  t.true(policy.includes(`script-src 'sha256-${digest}'`));
  t.true(policy.includes("default-src 'none'"));
  t.true(policy.includes("font-src 'self'"));
  t.true(policy.includes(`frame-ancestors ${PUBLIC_ORIGIN}`));
  t.false(policy.includes("unsafe-inline'; script"));
  // The bridge is what the preview panel listens for.
  t.true(inline?.includes("session-preview-scroll"));
});

test("Markdown that carries HTML is sanitized before it is served", async (t) => {
  const harness = createHarness(t);
  const path = await previewPath(harness, {
    name: "hostile.md",
    type: "text/markdown",
    body: '# Title\n\n<script>fetch("/steal")</script>\n\n<img src="x" onerror="alert(1)">\n\nOk.\n',
  });
  const html = await (await get(harness, path)).text();
  t.false(html.includes('fetch("/steal")'));
  t.false(html.includes("onerror"));
  t.false(html.toLowerCase().includes("<script>fetch"));
  t.true(html.includes("<h1>Title</h1>"));
  t.true(html.includes("Ok."));
  // Only the bridge survives as a script element.
  t.is(html.split("<script>").length - 1, 1);
});

test("the rendered page loads a body face only when one is named", async (t) => {
  const harness = createHarness(t);
  const path = await previewPath(harness, {
    name: "notes.md",
    type: "text/markdown",
    body: "hello",
  });

  const plain = await (await get(harness, path)).text();
  t.false(plain.includes("@font-face"));
  t.true(plain.includes("font-family: ui-sans-serif"));

  const dmSans = await (await get(harness, `${path}?session-body-font=dm-sans`)).text();
  t.true(dmSans.includes("/__session/fonts/DMSans-Variable-Latin.woff2"));
  t.true(dmSans.includes("font-family: 'DM Sans'"));

  const valley = await (await get(harness, `${path}?session-body-font=valley-sans`)).text();
  t.true(valley.includes("/__session/fonts/ValleySans-Variable.woff2"));
  t.false(valley.includes("DM Sans"));

  const nonsense = await (await get(harness, `${path}?session-body-font=comic-sans`)).text();
  t.false(nonsense.includes("@font-face"));
});

test("the fonts route serves the allowlist and nothing else", async (t) => {
  const harness = createHarness(t);

  for (const file of FONT_FILES) {
    const served = await get(harness, `/__session/fonts/${file}`);
    t.is(served.status, 200, file);
    t.is(served.headers.get("content-type"), "font/woff2");
    t.is(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const bytes = new Uint8Array(await served.arrayBuffer());
    t.deepEqual([...bytes.slice(0, 4)], [...new TextEncoder().encode("wOF2")], file);
  }

  // A file that sits next to the faces but is not one of them.
  t.is((await get(harness, "/__session/fonts/DMSans-OFL.txt")).status, 404);
  t.is((await get(harness, "/__session/fonts/..%2F..%2Fpackage.json")).status, 404);
  t.is((await get(harness, "/__session/fonts/")).status, 404);
  // And the app origin serves no fonts at all.
  t.is((await get(harness, `/__session/fonts/${FONT_FILES[0]}`, "localhost:8787")).status, 404);
});

test("a text document is shown as source rather than parsed as Markdown", async (t) => {
  const harness = createHarness(t);
  const path = await previewPath(harness, {
    name: "notes.txt",
    type: "text/plain",
    body: "# not a heading\n<b>not bold</b>\n",
  });
  const html = await (await get(harness, path)).text();
  t.true(html.includes('<pre class="session-source">'));
  t.true(html.includes("# not a heading"));
  t.true(html.includes("&lt;b&gt;not bold&lt;/b&gt;"));
  t.false(html.includes("<h1>"));
});

test("only the text family is rendered", (t) => {
  t.is(renderKind("text/markdown"), "markdown");
  t.is(renderKind("text/x-markdown"), "markdown");
  t.is(renderKind("text/plain; charset=utf-8"), "text");
  t.is(renderKind("text/csv"), "text");
  t.is(renderKind("application/json"), "text");
  // HTML stays `text/plain` on the byte path; rendering it would be the one
  // thing the artifact origin must never do.
  t.is(renderKind("text/html"), null);
  t.is(renderKind("application/pdf"), null);
  t.is(renderKind("image/png"), null);
});

test("the renderer and its helpers are conservative on their own", (t) => {
  t.is(renderMarkdown("# Hi").trim(), "<h1>Hi</h1>");
  t.false(renderMarkdown("<script>alert(1)</script>").includes("script"));
  t.false(renderMarkdown("[x](javascript:alert(1))").includes("javascript:"));
  t.is(parseBodyFont("dm-sans"), "dm-sans");
  t.is(parseBodyFont("valley-sans"), "valley-sans");
  t.is(parseBodyFont("inter"), null);
  t.is(parseBodyFont(undefined), null);
  t.is(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  t.true(renderedPageContentSecurityPolicy("https://session.dev").includes("object-src 'none'"));
  t.is(readFont("../../package.json"), null);
  t.not(readFont("ValleySans-Variable.woff2"), null);
});
