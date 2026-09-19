// The embedded post's markup, against the same fixtures and the same
// assertions the desktop pins (`tests/journal.test.ts:317-381`). The card is
// mounted by three surfaces — a journal entry, a Home research card, and a
// thread's question — so what it renders is a contract rather than one
// screen's detail, and the desktop's shape is the contract.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TweetSnapshot } from "@session/shared";
import { tweetSnapshotFromSyndication } from "@session/shared";
import test from "ava";
import { renderToStaticMarkup } from "react-dom/server";

import { TweetEmbed } from "../src/features/journal/TweetEmbed.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/test/fixtures/journal",
);

/** A real syndication payload, normalized the way hydration normalizes one. */
function snapshot(id: string): TweetSnapshot {
  const payload: unknown = JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8"));
  const parsed = tweetSnapshotFromSyndication(id, payload);
  if (!parsed) throw new Error(`fixture ${id} should hydrate`);
  return parsed;
}

function markup(id: string): string {
  return renderToStaticMarkup(<TweetEmbed tweet={snapshot(id)} />);
}

test("the card renders header, text, media, and a linked timestamp", (t) => {
  const html = markup("463440424141459456");
  t.regex(html, /aria-label="Open post by @Interior"/);
  t.regex(html, /role="link"/);
  t.regex(html, /tabindex="0"/);
  t.regex(html, /journal-tweet-head/);
  t.regex(html, /@Interior/);
  t.regex(html, /Sunsets don(&#x27;|')t get much better/);
  t.regex(html, /journal-tweet-media/);
  t.regex(html, /pbs\.twimg\.com\/media/);
  t.regex(
    html,
    /journal-tweet-age"[^>]*href="https:\/\/x\.com\/Interior\/status\/463440424141459456"/,
  );
});

test("a quoted post renders as a nested mini-card", (t) => {
  const html = markup("1599367266448994304");
  t.regex(html, /journal-tweet-quote/);
  t.is(html.match(/role="link"/g)?.length, 2);
  t.regex(html, /@CantBeFaraz/);
  // The outer video poster and the quoted post's own media both render.
  t.regex(html, /journal-tweet-video/);
  // Expanded link labels replace t.co.
  t.notRegex(html, /https:\/\/t\.co\//);
  t.regex(html, /codesandbox\.io/);
});

test("a long post offers Show more", (t) => {
  const html = markup("1623411400545632256");
  t.regex(html, /journal-tweet-more/);
  t.regex(html, /Show more/);
  t.regex(html, /…/);
});

test("the avatar, the inline header, and the counts lay out like a timeline", (t) => {
  const html = markup("20");
  // The avatar sits outside the content column, and the header is one line:
  // name, badge, handle, then the age linking to the post.
  t.regex(html, /journal-tweet-avatar-link/);
  t.regex(html, /journal-tweet-main/);
  t.regex(html, /journal-tweet-author"[^>]*>jack<\/a>/);
  t.regex(html, /journal-tweet-verified/);
  t.regex(html, /journal-tweet-handle">@jack<\/span>/);
  t.regex(html, /journal-tweet-age"[^>]*>[^<]+<\/a>/);
  // Counts read as metadata, never as controls.
  t.regex(html, /journal-tweet-stat/);
  t.regex(html, /309K/);
  t.notRegex(html, /<button/);
  // The embed chrome X's own widget draws is gone.
  t.notRegex(html, /journal-tweet-x"/);
  t.notRegex(html, /journal-tweet-foot/);
});

test("a link preview renders as its card", (t) => {
  const html = markup("1628832338187636740");
  // The wide variant is a modifier on the card, so the space before it is
  // load-bearing: without it the class is one unknown name and the card
  // renders in the small layout.
  t.regex(html, /journal-tweet-card is-large/);
  t.regex(html, /journal-tweet-card-domain">nextjs\.org</);
  t.regex(html, /journal-tweet-card-title">Next\.js 13\.2/);
  t.regex(html, /card_img/);
});

test("reply context is shown above the text", (t) => {
  const html = markup("1674865731136020505");
  t.regex(html, /journal-tweet-reply/);
  t.regex(html, /Replying to <span>@xDaily<\/span>/);
});

test("every destination is an external link that opens in a new tab", (t) => {
  const html = markup("1599367266448994304");
  for (const href of html.matchAll(/href="([^"]*)"/g)) {
    t.regex(href[1] ?? "", /^https:\/\//, "a card's links are absolute and external");
  }
  t.regex(html, /rel="noopener noreferrer"/);
  t.notRegex(html, /target="_self"/);
});
