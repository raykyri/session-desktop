import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TweetEmbed } from "../src/components/research/TweetEmbed";
import type { TweetSnapshot } from "../src/lib/tweets";

// Snapshots in the shape the backend resolves research message attachments
// into, derived from the real syndication payloads in fixtures/syndication.
function snapshot(id: string): TweetSnapshot {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "tweet-snapshots", `${id}.json`), "utf8"),
  );
}

function renderTweet(tweet: TweetSnapshot): string {
  return renderToStaticMarkup(createElement(TweetEmbed, { tweet }));
}

test("tweet card renders header, text, media, and plain timestamp", () => {
  const html = renderTweet(snapshot("463440424141459456"));
  assert.match(html, /aria-label="Open tweet by @Interior"/);
  assert.match(html, /role="link"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /journal-tweet-head/);
  assert.match(html, /@Interior/);
  assert.match(html, /Sunsets don(&#x27;|')t get much better/);
  assert.match(html, /journal-tweet-media/);
  assert.match(html, /pbs\.twimg\.com\/media/);
  assert.match(html, /<time class="journal-tweet-age"[^>]*>[^<]+<\/time>/);
});

test("tweet card renders quote tweets as a nested mini-card", () => {
  const html = renderTweet(snapshot("1599367266448994304"));
  assert.match(html, /journal-tweet-quote/);
  assert.equal(html.match(/role="link"/g)?.length, 2);
  assert.match(html, /@CantBeFaraz/);
  // Outer video poster and the quoted tweet's own media both render.
  assert.match(html, /journal-tweet-video/);
  // Expanded link labels replace t.co.
  assert.doesNotMatch(html, /https:\/\/t\.co\//);
  assert.match(html, /codesandbox\.io/);
});

test("tweet card offers Show more on a long post", () => {
  const html = renderTweet(snapshot("1623411400545632256"));
  assert.match(html, /journal-tweet-more/);
  assert.match(html, /Show more/);
  assert.match(html, /…/);
});

test("tweet card lays out avatar, inline header, and stats like a timeline", () => {
  const html = renderTweet(snapshot("20"));
  // Avatar sits outside the content column, and the header is one line:
  // name, badge, handle, then the plain timestamp.
  assert.match(html, /journal-tweet-avatar-link/);
  assert.match(html, /journal-tweet-main/);
  assert.match(html, /journal-tweet-author"[^>]*>jack<\/a>/);
  assert.match(html, /journal-tweet-verified/);
  assert.match(html, /journal-tweet-handle">@jack<\/span>/);
  assert.match(html, /<time class="journal-tweet-age"[^>]*>[^<]+<\/time>/);
  // Counts read as metadata, never as controls.
  assert.match(html, /journal-tweet-stat/);
  assert.match(html, /309K/);
  assert.doesNotMatch(html, /<button/);
  // The embed chrome is gone.
  assert.doesNotMatch(html, /journal-tweet-x"/);
  assert.doesNotMatch(html, /journal-tweet-foot/);
});

test("tweet card renders a link preview card", () => {
  const html = renderTweet(snapshot("1628832338187636740"));
  assert.match(html, /journal-tweet-card is-large/);
  assert.match(html, /journal-tweet-card-domain">nextjs\.org</);
  assert.match(html, /journal-tweet-card-title">Next\.js 13\.2</);
  assert.match(html, /card_img/);
});

test("tweet card shows reply context", () => {
  const html = renderTweet(snapshot("1674865731136020505"));
  assert.match(html, /journal-tweet-reply/);
  assert.match(html, /Replying to <span>@xDaily<\/span>/);
});
