// Untrusted text (04 Z5): answers, posts, replies, About and removal reasons
// are written by people and models. Fixture records holding `<script>`,
// `<img onerror>`, `javascript:` links, a remote image and a widget fence
// render with none of them in the DOM: plain-text fields are React text,
// answers go through the Markdown pipeline with raw HTML off, links pass
// `safeHref` and carry `rel="noopener noreferrer nofollow ugc"`, remote images
// are not fetched, and widget fences are not rendered as widgets.

import type { StoredRecord } from "@session/mutators";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { fixtureReplicaConfig, type FixtureReplica } from "../src/replica/fixtureReplica.js";
import { channelByName } from "../src/replica/queries.js";

import { renderApp, waitUntil } from "./helpers.js";

const SCRIPT = "<script>window.__pwned = 1</script>";
const IMG = '<img src="x" onerror="window.__pwned = 2">';
const HOSTILE_MD = [
  `Raw HTML: ${SCRIPT} and ${IMG}`,
  "",
  "[click me](javascript:window.__pwned=3) and [fine](https://example.com/a)",
  "",
  "![pixel](https://tracker.example/pixel.png)",
  "",
  '```session-html id=probe title="Probe"',
  '<p id="widget-probe">widget</p><script>window.__pwned = 4</script>',
  "```",
].join("\n");

let made: FixtureReplica[] = [];
let prepare: (replica: FixtureReplica) => void = () => {};

test.beforeEach(() => {
  made = [];
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      prepare(replica);
      made.push(replica);
      return replica;
    },
  });
});
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  configureReplica(null);
});

const rewrite = (replica: FixtureReplica, record: StoredRecord, change: Record<string, unknown>) =>
  replica.write([{ ...record, ...change }]);

/** What the DOM must not hold, wherever the text came from. */
function assertInert(t: ExecutionContext) {
  t.is(document.querySelectorAll("script").length, 0, "no script element");
  t.is(document.querySelectorAll("iframe").length, 0, "no widget frame");
  t.is(document.getElementById("widget-probe"), null, "no widget markup");
  for (const el of document.querySelectorAll("*"))
    for (const attr of el.attributes)
      t.false(attr.name.toLowerCase().startsWith("on"), `no ${attr.name} on <${el.tagName}>`);
  for (const a of document.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") ?? "").trim().toLowerCase();
    t.false(href.startsWith("javascript:"), href);
  }
  for (const img of document.querySelectorAll("img"))
    t.false(/^(https?:)?\/\//i.test(img.getAttribute("src") ?? ""), "no remote image");
  t.is((window as { __pwned?: number }).__pwned, undefined);
}

test.serial("hostile answers, posts, replies, About and reasons render inert", async (t) => {
  let ask = "";
  let post = "";
  prepare = (replica) => {
    const sp = channelByName(replica, "sci-fi");
    if (!sp) throw new Error("no #sci-fi");
    const space = replica.raw(`space:${sp.id}`);
    if (space) rewrite(replica, space, { desc: `About ${IMG} ${SCRIPT}` });
    const threads = replica.rawAll("thread").filter((r) => r.s === sp.id && r.mod === null);
    const answered = threads.find(
      (r) => r.k === "ask" && replica.raw(`answer:${r.id}`)?.kind === "answer",
    );
    const p = threads.find((r) => r.k === "post" && !r.del);
    const removed = threads.find((r) => r !== answered && r !== p);
    if (!answered || !p || !removed) throw new Error("fixture threads missing");
    ask = answered.id;
    post = p.id;
    const answer = replica.raw(`answer:${answered.id}`);
    if (answer) rewrite(replica, answer, { md: HOSTILE_MD });
    rewrite(replica, p, { q: `A post ${SCRIPT} ${IMG}` });
    const reply = replica.rawAll("reply").find((r) => r.th === p.id && !r.del && r.mod === null);
    if (reply) rewrite(replica, reply, { t: `A reply ${SCRIPT} [x](javascript:alert(1))` });
    rewrite(replica, removed, {
      mod: "removed",
      modBy: "ines.v",
      modNote: `Reason ${SCRIPT}`,
      q: "",
      t: null,
      sum: null,
    });
  };
  await renderApp("/c/sci-fi");
  await waitUntil(t, () => document.getElementById(`card-${ask}`) !== null, "the ask renders");
  await waitUntil(t, () => document.getElementById(`card-${post}`) !== null, "the post renders");
  const body = document.body.textContent ?? "";
  // plain-text fields show the markup as text
  t.true(body.includes(`A post ${SCRIPT}`));
  t.true(body.includes(`Reason: “Reason ${SCRIPT}”`));
  t.true(body.includes(`About ${IMG}`));
  // the answer's safe link is kept, with the rel of untrusted content
  const fine = screen.getByRole("link", { name: "fine" });
  t.is(fine.getAttribute("rel"), "noopener noreferrer nofollow ugc");
  t.is(screen.queryByRole("link", { name: "click me" }), null);
  assertInert(t);
  // About in the info dialog, as text
  fireEvent.click(screen.getByRole("button", { name: "About this channel" }));
  await screen.findByRole("dialog", { name: /^#sci-fi/ });
  assertInert(t);
});
