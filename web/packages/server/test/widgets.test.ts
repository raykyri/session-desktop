import { createHash } from "node:crypto";

import { snapshots } from "@session/db";
import test from "ava";
import { parse, serialize } from "parse5";

import { mintWidgetPreview, renderStaticWidget } from "../src/artifacts/widgets.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, answerTurn, createHarness } from "./helpers.js";

const host = new URL(ARTIFACT_ORIGIN).host;
const frame = { Host: host, "Sec-Fetch-Dest": "iframe" };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const STORED_WIDGET =
  '<p id="result">Static figure</p><script>fetch("https://bad.invalid")</script><meta HTTP-EQUIV="refresh" content="0;url=https://bad.invalid"><a href="https://bad.invalid">link</a>';

test("widget previews serve only widgets of stored answers the caller can read", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("widget-owner");
  const caller = harness.caller(owner);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "Draw a figure",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]!.id;
  snapshots.commit(harness.db, owner.id, {
    nodeId,
    turns: [
      answerTurn(
        nodeId,
        `Prose.\n\n\`\`\`session-html title="Figure"\n${STORED_WIDGET}\n\`\`\`\n\n\`\`\`session-html\n<p>unclosed</p>`,
      ),
    ],
    outcome: { status: "complete" },
  });

  await t.throwsAsync(
    harness.caller(null).artifacts.prepareWidget({ nodeId, sha256: sha256(STORED_WIDGET) }),
    { code: "UNAUTHORIZED" },
  );
  // HTML that is not a complete widget block of the answer is never minted.
  for (const html of ["<p>client supplied</p>", "<p>unclosed</p>"])
    await t.throwsAsync(caller.artifacts.prepareWidget({ nodeId, sha256: sha256(html) }), {
      code: "NOT_FOUND",
    });
  const stranger = harness.caller(harness.addUser("stranger"));
  await t.throwsAsync(stranger.artifacts.prepareWidget({ nodeId, sha256: sha256(STORED_WIDGET) }), {
    message: /not found/u,
  });

  const minted = await caller.artifacts.prepareWidget({ nodeId, sha256: sha256(STORED_WIDGET) });
  t.is(new URL(minted.url).origin, ARTIFACT_ORIGIN);
  const path = new URL(minted.url).pathname;
  const response = await harness.app.request(path, { headers: frame });
  t.is(response.status, 200);
  t.is(response.headers.get("cache-control"), "no-store");
  t.is(response.headers.get("set-cookie"), null);
  const policy = response.headers.get("content-security-policy") ?? "";
  t.true(policy.includes("script-src 'none'"));
  t.true(policy.endsWith("; sandbox"));
  t.true(policy.includes(`frame-ancestors ${PUBLIC_ORIGIN}`));
  t.false(policy.includes("allow-scripts"));
  const html = await response.text();
  t.true(html.includes("Static figure"));
  t.false(/<script|<meta|href=/iu.test(html));

  // Only a frame may load the page: no top-level visit, no subresource load,
  // and no request without Fetch Metadata.
  for (const destination of ["document", "image", "script", "empty", undefined]) {
    const headers: Record<string, string> = { Host: host };
    if (destination) headers["Sec-Fetch-Dest"] = destination;
    t.is((await harness.app.request(path, { headers })).status, 403, String(destination));
  }
  t.is(
    (
      await harness.app.request(path, {
        headers: { ...frame, Host: new URL(PUBLIC_ORIGIN).host },
      })
    ).status,
    404,
  );
  t.is((await harness.app.request("/w/" + "f".repeat(64), { headers: frame })).status, 410);
  const expired = mintWidgetPreview(harness.db, "u", "<p>old</p>", 0);
  t.is((await harness.app.request(`/w/${expired.token}`, { headers: frame })).status, 410);
  await t.throwsAsync(caller.artifacts.prepareWidget({ nodeId, sha256: "x" }), {
    code: "BAD_REQUEST",
  });
});

test("a full preview cache evicts the least recently used page from an account with the highest page count", async (t) => {
  const harness = createHarness(t);
  const status = async (token: string) =>
    (await harness.app.request(`/w/${token}`, { headers: frame })).status;
  const lowerCountPreview = mintWidgetPreview(harness.db, "lower-count", "<p>lower count</p>");
  // Four users fill the 256-page cache to their 64-page caps.
  const highestCountTokens: string[] = [];
  for (const user of ["a", "b", "c", "d"])
    for (let index = 0; index < 64; index += 1)
      highestCountTokens.push(mintWidgetPreview(harness.db, user, `<p>${user}${index}</p>`).token);
  t.is(await status(lowerCountPreview.token), 200, "the lower-count account's page remains cached");
  // The 257th page evicts the least recently used page from an account with
  // the highest page count.
  t.is(await status(highestCountTokens[0]!), 410);
  t.is(await status(highestCountTokens[64]!), 200);
  // Serving refreshes recency: b's first page is now its newest, so the next
  // eviction removes b's second page because b now has the highest page count.
  mintWidgetPreview(harness.db, "e", "<p>e</p>");
  t.is(await status(highestCountTokens[64]!), 200);
  t.is(await status(highestCountTokens[65]!), 410);
  t.is(await status(lowerCountPreview.token), 200);
  // A user's own 64-page cap evicts that user's least recently used page.
  for (let index = 0; index < 64; index += 1)
    mintWidgetPreview(harness.db, "lower-count", `<p>more ${index}</p>`);
  t.is(await status(lowerCountPreview.token), 410);
});

test("static sanitization removes forms' actions, focus grabs and embedded navigation", (t) => {
  const html = renderStaticWidget(
    '<form action="https://bad.invalid"><input autofocus><button formaction="https://bad.invalid">Go</button></form><svg><a xlink:href="https://bad.invalid"><text>x</text></a></svg><iframe srcdoc="evil"></iframe><img src="data:image/png;base64,x" onerror="alert(1)"><style>p{color:red}</style>',
  );
  t.false(/\s(?:action|formaction|autofocus|onerror|href|xlink:href)=|<iframe/iu.test(html));
  t.true(html.includes("p{color:red}"));
});

test("local SVG symbols survive but animated navigation and template payloads do not", (t) => {
  const html = renderStaticWidget(
    '<svg><defs><symbol id="dot"><circle r="4"/></symbol></defs><use href="#dot"/><a><set attributeName="href" to="https://bad.invalid"/></a></svg><template><meta http-equiv="refresh" content="0;url=https://bad.invalid"></template>',
  );
  t.true(html.includes('href="#dot"'));
  t.false(/<set|<template|bad.invalid/iu.test(html));
});

/** Markup on which HTML parsers have disagreed with each other or with a
 * serialize/re-parse round trip (comment terminators, raw-text and
 * scripting-dependent elements, foreign-content namespace switches). */
const PARSER_DIFFERENTIALS: Record<string, string> = {
  comment_bang: '<!--x--!><a href="https://evil.example/c3">C3</a>-->',
  comment_abrupt: '<!--><a href="https://evil.example/c1">C1</a>-->',
  comment_abrupt_dash: '<!---><a href="https://evil.example/c2">C2</a>-->',
  comment_inner_dashes: '<!-- -- --!--><a href="https://evil.example/c4">C4</a>-->',
  comment_in_svg: '<svg><!--</svg><a href="https://evil.example/c5">C5</a>--></svg>',
  cdata_svg: '<svg><![CDATA[</svg><a href="https://evil.example/cd">CD</a>]]></svg>',
  cdata_html: '<![CDATA[<a href="https://evil.example/ch">CH</a>]]>',
  processing_instruction: '<?xml <a href="https://evil.example/pi">PI</a> ?>',
  svg_style: '<svg></p><style><a id="</style><a href=https://evil.example/s2>S2</a>">',
  math_mglyph_style:
    '<math><mtext><table><mglyph><style><!--</style><a title="--&gt;&lt;/mglyph&gt;&lt;a href=https://evil.example/m1&gt;M1&lt;/a&gt;">x</a>',
  form_nesting:
    '<form><math><mtext></form><form><mglyph><style></math><a href="https://evil.example/f1">F1</a>',
  noscript:
    '<noscript><p title="</noscript><a href=https://evil.example/n1>N1</a>">x</p></noscript>',
  noembed: '<noembed><a href="https://evil.example/ne">NE</a></noembed>',
  noframes: '<noframes><a href="https://evil.example/nf">NF</a></noframes>',
  xmp: '<xmp></xmp><a href="https://evil.example/x1">X1</a>',
  plaintext: '<plaintext><a href="https://evil.example/pt">PT</a>',
  title: '<title><a href="https://evil.example/th">TH</a></title>',
  textarea: '<textarea></textarea><a href="https://evil.example/ta">TA</a>',
  area: '<map name="m"><area shape="default" href="https://evil.example/ar"></map>',
  mathml_href: '<math href="https://evil.example/mh"><mi>MH</mi></math>',
};

/** Every href-like attribute and comment a WHATWG parser (with scripting off,
 * as in the sandboxed frame) builds from the served page. */
function liveReferences(markup: string): string[] {
  const found: string[] = [];
  const visit = (node: {
    nodeName: string;
    attrs?: { name: string; value: string }[];
    childNodes?: unknown[];
  }) => {
    if (node.nodeName === "#comment") found.push("comment");
    for (const attribute of node.attrs ?? [])
      if (/href|action/iu.test(attribute.name) && !attribute.value.startsWith("#"))
        found.push(`${node.nodeName} ${attribute.name}=${attribute.value}`);
    for (const child of node.childNodes ?? []) visit(child as typeof node);
  };
  visit(parse(markup, { scriptingEnabled: false }));
  visit(parse(markup, { scriptingEnabled: true }));
  return found;
}

test("parser-differential markup leaves no live link and is a serialization fixed point", (t) => {
  for (const [name, payload] of Object.entries(PARSER_DIFFERENTIALS)) {
    const page = renderStaticWidget(payload);
    t.deepEqual(liveReferences(page), [], name);
    t.false(page.includes("<!--"), name);
    t.is(serialize(parse(page, { scriptingEnabled: false })), page, `${name} re-serializes as is`);
    const body = page.slice(page.indexOf("<body>") + 6, page.lastIndexOf("</body>"));
    t.is(renderStaticWidget(body), page, `${name} sanitizes to itself`);
  }
});
