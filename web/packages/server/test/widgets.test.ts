import { createHash } from "node:crypto";

import { snapshots } from "@session/db";
import test from "ava";
import { parse, serialize } from "parse5";

import { siteOf, widgetScriptPolicy } from "../src/artifacts/site.js";
import { mintWidgetPreview, renderStaticWidget } from "../src/artifacts/widgets.js";

import type { Harness } from "./helpers.js";
import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, answerTurn, createHarness } from "./helpers.js";

const host = new URL(ARTIFACT_ORIGIN).host;
const frame = { Host: host, "Sec-Fetch-Dest": "iframe" };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const STORED_WIDGET =
  '<p id="result">Static figure</p><script>fetch("https://bad.invalid")</script><meta HTTP-EQUIV="refresh" content="0;url=https://bad.invalid"><a href="https://bad.invalid">link</a>';

/** A thread whose root answer is `answer`, owned by a new account. */
async function threadWithAnswer(
  harness: Harness,
  answer: string | ((nodeId: string) => string),
  login = "widget-owner",
) {
  const owner = harness.addUser(login);
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
    turns: [answerTurn(nodeId, typeof answer === "string" ? answer : answer(nodeId))],
    outcome: { status: "complete" },
  });
  return { owner, caller, nodeId, treeId: detail.tree.id };
}

/** The `<body>` of a served page: the widget's part, after Session's head. */
const bodyOf = (page: string) =>
  page.slice(page.indexOf("<body>") + 6, page.lastIndexOf("</body>"));

/** The inline scripts of a page's `<head>`. */
function headScripts(page: string): string[] {
  const head = page.slice(0, page.indexOf("</head>"));
  return [...head.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
}

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/u);
      return [name!, rest.join(" ")];
    }),
  );
}

test("widget pages serve only widgets of stored answers the caller can read", async (t) => {
  const harness = createHarness(t);
  const { caller, nodeId } = await threadWithAnswer(
    harness,
    `Prose.\n\n\`\`\`session-html title="Figure"\n${STORED_WIDGET}\n\`\`\`\n\n\`\`\`session-html\n<p>unclosed</p>`,
  );

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
  t.is(new URL(minted.staticUrl).origin, ARTIFACT_ORIGIN);
  t.truthy(minted.runUrl);
  t.is(new URL(minted.runUrl!).origin, ARTIFACT_ORIGIN);
  t.not(minted.runUrl, minted.staticUrl);

  // The static page: Session's two hashed scripts and nothing of the widget's.
  const path = new URL(minted.staticUrl).pathname;
  const response = await harness.app.request(path, { headers: { ...frame, Cookie: "session=x" } });
  t.is(response.status, 200);
  t.is(response.headers.get("cache-control"), "no-store");
  t.is(response.headers.get("set-cookie"), null);
  t.is(response.headers.get("x-frame-options"), null);
  t.true(response.headers.get("permissions-policy")?.includes("camera=()"));
  const page = await response.text();
  const policy = directives(response.headers.get("content-security-policy") ?? "");
  t.is(policy.get("default-src"), "'none'");
  t.is(policy.get("connect-src"), "'none'");
  t.is(policy.get("form-action"), "'none'");
  t.is(policy.get("img-src"), "data: blob:");
  t.is(policy.get("base-uri"), "'none'");
  t.is(policy.get("frame-ancestors"), PUBLIC_ORIGIN);
  t.is(policy.get("sandbox"), "allow-scripts");
  const scripts = headScripts(page);
  t.is(scripts.length, 2);
  t.deepEqual(
    policy.get("script-src")?.split(" "),
    scripts.map(
      (script) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`,
    ),
  );
  t.true(page.includes("Static figure"));
  t.false(/<script|<meta|href=/iu.test(bodyOf(page)));

  // The run page: the widget's HTML with inline scripts, `http-equiv` renamed.
  const run = await harness.app.request(new URL(minted.runUrl!).pathname, { headers: frame });
  t.is(run.status, 200);
  t.is(run.headers.get("set-cookie"), null);
  const runPolicy = directives(run.headers.get("content-security-policy") ?? "");
  t.is(runPolicy.get("script-src"), "'unsafe-inline'");
  t.is(runPolicy.get("sandbox"), "allow-scripts");
  t.is(runPolicy.get("connect-src"), "'none'");
  t.is(runPolicy.get("default-src"), "'none'");
  t.is(runPolicy.get("form-action"), "'none'");
  t.is(runPolicy.get("frame-ancestors"), PUBLIC_ORIGIN);
  for (const value of [...runPolicy.values(), ...policy.values()])
    t.false(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/u.test(value));
  const runPage = await run.text();
  t.true(bodyOf(runPage).includes('<script>fetch("https://bad.invalid")</script>'));
  t.true(bodyOf(runPage).includes('<meta data-HTTP-EQUIV="refresh"'));
  t.true(runPage.includes("sessionWidgetState"));
  // Session's guard runs before anything else on the page.
  t.true(headScripts(runPage)[0]!.includes("session-widget-ping"));

  // Only a frame may load the page: no top-level visit, no subresource load,
  // and no request without Fetch Metadata.
  for (const destination of ["document", "image", "script", "empty", undefined]) {
    const headers: Record<string, string> = { Host: host };
    if (destination) headers["Sec-Fetch-Dest"] = destination;
    t.is((await harness.app.request(path, { headers })).status, 403, String(destination));
  }
  // Never on the app host.
  t.is(
    (
      await harness.app.request(path, {
        headers: { ...frame, Host: new URL(PUBLIC_ORIGIN).host },
      })
    ).status,
    404,
  );
  // Nothing but GET and HEAD of one token path on the artifact host.
  t.is((await harness.app.request(path, { method: "POST", headers: frame })).status, 404);
  t.is((await harness.app.request(`${path}/x`, { headers: frame })).status, 404);
  t.is((await harness.app.request("/w/" + "f".repeat(64), { headers: frame })).status, 410);
  const expired = mintWidgetPreview(harness.db, "u", "<p>old</p>", { scripts: true, now: 0 });
  t.is((await harness.app.request(`/w/${expired.staticToken}`, { headers: frame })).status, 410);
  t.is((await harness.app.request(`/w/${expired.runToken!}`, { headers: frame })).status, 410);
  await t.throwsAsync(caller.artifacts.prepareWidget({ nodeId, sha256: "x" }), {
    code: "BAD_REQUEST",
  });
});

test("an artifact origin on the app's site turns widget scripts off", async (t) => {
  t.is(siteOf("artifacts.session.dev"), "session.dev");
  t.is(siteOf("session.dev"), "session.dev");
  t.is(siteOf("a.fly.dev"), "a.fly.dev");
  t.is(siteOf("127.0.0.1"), "127.0.0.1");
  t.is(siteOf("[::1]"), "::1");
  t.is(siteOf("localhost"), "localhost");
  const off = [
    ["https://session.dev", "https://artifacts.session.dev"],
    ["https://app.session.dev", "https://artifacts.session.dev"],
    ["https://session.co.uk", "https://widgets.session.co.uk"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
    ["http://session.dev", "https://artifacts.session.dev"],
  ] as const;
  for (const [app, artifacts] of off) {
    const policy = widgetScriptPolicy(app, artifacts);
    t.false(policy.allowed, `${app} ${artifacts}`);
    t.true(policy.reason?.includes("SESSION_ARTIFACT_ORIGIN"));
  }
  const on = [
    ["https://session.dev", "https://session-widgets.dev"],
    ["https://app.fly.dev", "https://widgets.fly.dev"],
    ["http://127.0.0.1:8788", "http://localhost:8788"],
    ["http://localhost:1480", "http://artifacts.localhost:8787"],
  ] as const;
  for (const [app, artifacts] of on)
    t.deepEqual(widgetScriptPolicy(app, artifacts), { allowed: true, reason: null });

  // The deployed pair (`web/fly.toml`) serves no run page.
  const harness = createHarness(t, {
    env: {
      SESSION_PUBLIC_ORIGIN: "https://session.dev",
      SESSION_ARTIFACT_ORIGIN: "https://artifacts.session.dev",
    },
  });
  t.false(harness.config.widgetScripts.allowed);
  const html = "<p>x</p><script>1</script>";
  const { caller, nodeId } = await threadWithAnswer(harness, `\`\`\`session-html\n${html}\n\`\`\``);
  const minted = await caller.artifacts.prepareWidget({ nodeId, sha256: sha256(html) });
  t.is(minted.runUrl, null);
  // A run token is refused while scripts are off, however it was minted.
  const forged = mintWidgetPreview(harness.db, "u", html, { scripts: true });
  const artifactHost = { Host: "artifacts.session.dev", "Sec-Fetch-Dest": "iframe" };
  t.is(
    (await harness.app.request(`/w/${forged.runToken!}`, { headers: artifactHost })).status,
    410,
  );
  const page = await harness.app.request(`/w/${forged.staticToken}`, { headers: artifactHost });
  t.is(page.status, 200);
  t.false((await page.text()).includes("<script>1</script>"));
});

test("revisions are registered from the stored answer and listed in lineage order", async (t) => {
  const harness = createHarness(t);
  const root = "<p>root</p>";
  const child = "<p>child</p><script>1</script>";
  // The root's revision id is derived from the answer node, so the child's
  // fence can name it (the desktop's revision rule).
  const revisionOf = (nodeId: string) =>
    sha256(JSON.stringify(["chart", nodeId, sha256(root), null]));
  const { caller, nodeId, treeId } = await threadWithAnswer(
    harness,
    (id) =>
      `Text.\n\n\`\`\`session-html id=chart title="Chart"\n${root}\n\`\`\`\n\n\`\`\`session-html id=chart parent=${revisionOf(id)}\n${child}\n\`\`\``,
  );
  const rootRevision = revisionOf(nodeId);

  // Client-supplied HTML, or the right HTML under other metadata, is refused.
  await t.throwsAsync(
    caller.artifacts.register({ nodeId, slot: "0", html: "<p>other</p>", meta: "id=chart" }),
    { code: "NOT_FOUND" },
  );
  await t.throwsAsync(
    caller.artifacts.register({ nodeId, slot: "0", html: root, meta: 'id=evil title="Evil"' }),
    { code: "NOT_FOUND" },
  );
  const stranger = harness.caller(harness.addUser("stranger"));
  await t.throwsAsync(
    stranger.artifacts.register({ nodeId, slot: "0", html: root, meta: 'id=chart title="Chart"' }),
    { code: "NOT_FOUND" },
  );

  const registered = await caller.artifacts.register({
    nodeId,
    slot: "item:0",
    html: root,
    meta: 'id=chart title="Chart"',
  });
  t.like(registered, {
    artifactId: "chart",
    title: "Chart",
    treeId,
    nodeId,
    revision: rootRevision,
    parentRevision: null,
    unresolvedParent: false,
  });

  // History stores the child it finds in the thread's answers.
  const history = await caller.artifacts.history({ treeId, artifactId: "chart" });
  t.is(history.unresolved, 0);
  t.deepEqual(
    history.revisions.map((entry) => [entry.html, entry.parentRevision]),
    [
      [root, null],
      [child, rootRevision],
    ],
  );
  await t.throwsAsync(stranger.artifacts.history({ treeId, artifactId: "chart" }), {
    code: "NOT_FOUND",
  });

  // A stored revision can be previewed by reference.
  const childRef = { treeId, artifactId: "chart", revision: history.revisions[1]!.revision };
  const preview = await caller.artifacts.prepareWidget(childRef);
  const served = await harness.app.request(new URL(preview.runUrl!).pathname, { headers: frame });
  t.true((await served.text()).includes(child));
  await t.throwsAsync(stranger.artifacts.prepareWidget(childRef), { code: "NOT_FOUND" });
  await t.throwsAsync(caller.artifacts.prepareWidget({ ...childRef, revision: "c".repeat(64) }), {
    code: "NOT_FOUND",
  });

  // Saved inputs: the desktop's actions, per person, never for a stranger.
  const rootRef = { treeId, artifactId: "chart", revision: rootRevision };
  t.deepEqual(await caller.artifacts.getState(childRef), { enabled: false, value: null });
  await t.throwsAsync(
    caller.artifacts.updateState({ reference: childRef, action: "save", value: { v: 1 } }),
    { code: "BAD_REQUEST", message: "remembering inputs is disabled" },
  );
  await caller.artifacts.updateState({ reference: rootRef, action: "enable" });
  await caller.artifacts.updateState({ reference: rootRef, action: "save", value: { v: 1 } });
  await caller.artifacts.updateState({ reference: childRef, action: "enable" });
  t.deepEqual(await caller.artifacts.updateState({ reference: childRef, action: "migrate" }), {
    enabled: true,
    value: { v: 1 },
  });
  await t.throwsAsync(
    caller.artifacts.updateState({
      reference: childRef,
      action: "save",
      value: { big: "x".repeat(17 * 1024) },
    }),
    { message: "saved inputs exceed the 16 KiB limit" },
  );
  await t.throwsAsync(stranger.artifacts.getState(childRef), { code: "NOT_FOUND" });
  await t.throwsAsync(stranger.artifacts.updateState({ reference: childRef, action: "enable" }), {
    code: "NOT_FOUND",
  });
  await t.throwsAsync(caller.artifacts.getState({ ...childRef, revision: "c".repeat(64) }), {
    code: "NOT_FOUND",
  });
});

test("widget procedures have their own budget, apart from the mutation budget", async (t) => {
  const harness = createHarness(t);
  const html = "<p>x</p>";
  const { caller, nodeId } = await threadWithAnswer(harness, `\`\`\`session-html\n${html}\n\`\`\``);
  // More than the 60-a-minute mutation budget.
  for (let index = 0; index < 80; index += 1)
    await caller.artifacts.prepareWidget({ nodeId, sha256: sha256(html) });
  await t.notThrowsAsync(caller.workspaces.ensureDefault());
});

test("a full preview cache evicts the least recently used page from an account with the highest page count", async (t) => {
  const harness = createHarness(t);
  const mint = (user: string, html: string) =>
    mintWidgetPreview(harness.db, user, html, { scripts: true }).staticToken;
  const status = async (token: string) =>
    (await harness.app.request(`/w/${token}`, { headers: frame })).status;
  const lowerCountPreview = mint("lower-count", "<p>lower count</p>");
  // Four users fill the 256-page cache to their 64-page caps.
  const highestCountTokens: string[] = [];
  for (const user of ["a", "b", "c", "d"])
    for (let index = 0; index < 64; index += 1)
      highestCountTokens.push(mint(user, `<p>${user}${index}</p>`));
  t.is(await status(lowerCountPreview), 200, "the lower-count account's page remains cached");
  // The 257th page evicts the least recently used page from an account with
  // the highest page count.
  t.is(await status(highestCountTokens[0]!), 410);
  t.is(await status(highestCountTokens[64]!), 200);
  // Serving refreshes recency: b's first page is now its newest, so the next
  // eviction removes b's second page because b now has the highest page count.
  mint("e", "<p>e</p>");
  t.is(await status(highestCountTokens[64]!), 200);
  t.is(await status(highestCountTokens[65]!), 410);
  t.is(await status(lowerCountPreview), 200);
  // A user's own 64-page cap evicts that user's least recently used page.
  for (let index = 0; index < 64; index += 1) mint("lower-count", `<p>more ${index}</p>`);
  t.is(await status(lowerCountPreview), 410);
});

test("static sanitization removes forms' actions, focus grabs and embedded navigation", (t) => {
  const html = bodyOf(
    renderStaticWidget(
      '<form action="https://bad.invalid"><input autofocus><button formaction="https://bad.invalid">Go</button></form><svg><a xlink:href="https://bad.invalid"><text>x</text></a></svg><iframe srcdoc="evil"></iframe><img src="data:image/png;base64,x" onerror="alert(1)"><style>p{color:red}</style>',
    ),
  );
  t.false(/\s(?:action|formaction|autofocus|onerror|href|xlink:href)=|<iframe/iu.test(html));
  t.true(html.includes("p{color:red}"));
});

test("local SVG symbols survive but animated navigation and template payloads do not", (t) => {
  const html = bodyOf(
    renderStaticWidget(
      '<svg><defs><symbol id="dot"><circle r="4"/></symbol></defs><use href="#dot"/><a><set attributeName="href" to="https://bad.invalid"/></a></svg><template><meta http-equiv="refresh" content="0;url=https://bad.invalid"></template>',
    ),
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
  script_tag: '<script>parent.location="https://evil.example/s"</script><p>x</p>',
};

/** Every href-like attribute, comment and script a WHATWG parser builds from
 * the served page's body, with scripting off and on (the static frame runs
 * Session's scripts, so the browser parses with scripting on). */
function liveReferences(markup: string): string[] {
  const found: string[] = [];
  const visit = (node: {
    nodeName: string;
    attrs?: { name: string; value: string }[];
    childNodes?: unknown[];
  }) => {
    if (node.nodeName === "#comment") found.push("comment");
    if (node.nodeName === "script") found.push("script");
    for (const attribute of node.attrs ?? [])
      if (/href|action|^on/iu.test(attribute.name) && !attribute.value.startsWith("#"))
        found.push(`${node.nodeName} ${attribute.name}=${attribute.value}`);
    for (const child of node.childNodes ?? []) visit(child as typeof node);
  };
  const body = `<!DOCTYPE html><html><head></head><body>${bodyOf(markup)}</body></html>`;
  visit(parse(body, { scriptingEnabled: false }));
  visit(parse(body, { scriptingEnabled: true }));
  return found;
}

test("parser-differential markup leaves no live link and is a serialization fixed point", (t) => {
  for (const [name, payload] of Object.entries(PARSER_DIFFERENTIALS)) {
    const page = renderStaticWidget(payload);
    t.deepEqual(liveReferences(page), [], name);
    t.false(page.includes("<!--"), name);
    t.is(serialize(parse(page, { scriptingEnabled: false })), page, `${name} re-serializes as is`);
    t.is(serialize(parse(page, { scriptingEnabled: true })), page, `${name} with scripting on`);
    t.is(renderStaticWidget(bodyOf(page)), page, `${name} sanitizes to itself`);
  }
});
