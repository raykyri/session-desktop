import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles", "features");
const tokensCss = readFileSync(join(stylesDirectory, "..", "tokens.css"), "utf8");
const surfaceCss = readFileSync(join(stylesDirectory, "research-surface.css"), "utf8");
const researchCss = readFileSync(join(stylesDirectory, "research.css"), "utf8");
const feedCss = readFileSync(join(stylesDirectory, "feed.css"), "utf8");
const transcriptCss = readFileSync(join(stylesDirectory, "transcript.css"), "utf8");
const postsCss = readFileSync(join(stylesDirectory, "posts.css"), "utf8");
const reducedMotionCss = readFileSync(join(stylesDirectory, "..", "reduced-motion.css"), "utf8");

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("DM Sans adds one optical half-pixel to UI type but not monospace text", () => {
  const root = ruleBody(tokensCss, ":root");
  for (const token of ["xs", "sm", "base", "input"]) {
    assert.match(
      root,
      new RegExp(`--fs-${token}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)\\)`),
    );
  }
  assert.match(
    ruleBody(tokensCss, ':root[data-body-font="dm-sans"]'),
    /--font-ui-size-offset:\s*0\.5px/,
  );

  const researchScale = ruleBody(surfaceCss, ".research-reading-surface");
  assert.match(
    researchScale,
    /--research-markdown-font-delta:[^;]+- var\(--font-ui-size-offset\)/s,
  );

  const heading = ruleBody(transcriptCss, ".turn-markdown h1");
  assert.match(heading, /font-size:[^;]+\+ var\(--font-ui-size-offset\)/);
  const code = ruleBody(transcriptCss, ".turn-markdown code");
  assert.doesNotMatch(code, /font-ui-size-offset/);
});

test("research recaps get typography only from the shared surface recipe", () => {
  const recap = ruleBody(surfaceCss, ".research-recap-text");
  assert.match(recap, /font-size:\s*var\(--research-recap-font-size\)/);
  assert.match(recap, /line-height:\s*var\(--research-recap-line-height\)/);

  // Feed questions use the compact line height and a font size 1px larger.
  const cardQuestion = ruleBody(feedCss, ".research-feed-card-question");
  assert.match(cardQuestion, /font-size:\s*calc\(var\(--research-compact-font-size\) \+ 1px\)/);
  assert.match(cardQuestion, /line-height:\s*var\(--research-compact-line-height\)/);

  const threadPlacement = ruleBody(researchCss, ".research-recap");
  assert.doesNotMatch(threadPlacement, /font(?:-size|-style|-weight)?\s*:/);
  assert.doesNotMatch(threadPlacement, /line-height\s*:/);
});

test("research prose adapts transcript typography on the renderer, not layout roots", () => {
  const readingSurface = ruleBody(surfaceCss, ".research-reading-surface");
  assert.doesNotMatch(readingSurface, /--transcript-/);

  const prose = ruleBody(surfaceCss, ".turn-markdown.research-prose");
  assert.match(prose, /--transcript-font-delta:/);
  assert.match(prose, /--transcript-line-height-delta:/);
  assert.match(prose, /font-size:\s*var\(--research-body-font-size\)/);
  assert.match(prose, /line-height:\s*var\(--research-body-line-height\)/);

  const responseRoot = ruleBody(researchCss, ".research-response-content-root");
  assert.doesNotMatch(responseRoot, /--transcript-/);
  assert.doesNotMatch(responseRoot, /line-height\s*:/);

  assert.doesNotMatch(
    `${researchCss}\n${feedCss}`,
    /--research-(?:reading-(?:body|meta)|answer-font-delta)/,
  );
});

test("shared tweet and attachment recipes do not depend on Home CSS", () => {
  assert.match(surfaceCss, /\.tweet-embed\s*\{/);
  assert.match(surfaceCss, /\.research-message-attachments\.has-prompt\s*\{/);
  const tweet = ruleBody(surfaceCss, ".tweet-embed");
  assert.match(tweet, /max-width:\s*var\(--research-feed-max-width\)/);
  const attachment = ruleBody(surfaceCss, ".research-message-attachment");
  assert.match(attachment, /width:\s*min\(100%, var\(--research-feed-max-width\)\)/);
  assert.match(attachment, /border:\s*1px solid var\(--surface-border-default\)/);
  assert.match(attachment, /border-radius:\s*12px/);
  const tweetStats = ruleBody(surfaceCss, ".tweet-embed-stats");
  assert.match(tweetStats, /align-items:\s*center/);
  assert.match(tweetStats, /line-height:\s*1/);
  assert.doesNotMatch(
    ruleBody(surfaceCss, ".research-message-attachments.has-prompt"),
    /border-top/,
  );
  assert.doesNotMatch(feedCss, /\.research-message-attachments\.has-prompt\s*\{/);
  // Feed cards set attachment spacing; shared styles set attachment sizes.
  const cardAttachments = ruleBody(feedCss, ".research-feed-card .research-message-attachments");
  assert.match(cardAttachments, /^\s*margin-top:\s*6px;\s*$/);
});

test("a row's glyph is a 14px float at the start of its first line, centered on it, 6px before the text", () => {
  const glyph = ruleBody(feedCss, ".research-row-glyph");
  assert.match(glyph, /float:\s*left/);
  assert.match(glyph, /width:\s*14px;\s*height:\s*14px/);
  // Centered on the line it inherits its line height from, with a fallback
  // where `lh` is not supported.
  assert.match(glyph, /margin-top:\s*3px;\s*margin-top:\s*calc\(\(1lh - 14px\) \/ 2\)/);
  assert.match(glyph, /margin-right:\s*6px/);
  assert.match(glyph, /color:\s*var\(--research-row-glyph-color, var\(--text-faint\)\)/);
  assert.match(ruleBody(feedCss, ".research-row-glyph > svg"), /stroke-width:\s*1\.5px/);
  assert.match(
    ruleBody(feedCss, ":is(.research-feed-card, .research-feed-child, .research-msg-row).is-selected"),
    /--research-row-glyph-color:\s*var\(--text-muted\)/,
  );
  assert.match(ruleBody(feedCss, ".research-row-glyph.is-tone-running"), /color:\s*var\(--status-active-fg\)/);
  assert.match(ruleBody(feedCss, ".research-row-glyph.is-tone-failed"), /color:\s*var\(--status-failed-fg\)/);
  assert.match(ruleBody(feedCss, ".research-row-glyph.is-tone-unread"), /color:\s*var\(--text-secondary\)/);
  // In a tweet's header (a flex row with its own gap) it is not floated.
  assert.match(ruleBody(feedCss, ".tweet-embed-head > .research-row-glyph"), /float:\s*none;\s*margin:\s*0/);

  // The texts that hold it are flow roots, so the float stays inside them.
  const content = ruleBody(feedCss, ".research-feed-card-content");
  assert.match(content, /display:\s*flow-root/);
  assert.doesNotMatch(content, /flex|gap:/);
  assert.match(ruleBody(feedCss, ".research-feed-card-content > * + *"), /margin-top:\s*2px/);
  assert.match(ruleBody(researchCss, ".research-msg-content"), /display:\s*flow-root;\s*padding:\s*10px 12px 2px;/);
  // A message's Markdown sets its own type, which the glyph before it takes.
  assert.match(
    ruleBody(researchCss, ".research-msg-prompt > .research-row-glyph"),
    /font-size:\s*calc\(var\(--research-compact-font-size\) \+ 1px\);\s*line-height:\s*var\(--research-compact-line-height\)/,
  );
  // A child row's float is in a block inside the clamped box: WebKit does not
  // float a -webkit-box's own children.
  assert.match(ruleBody(feedCss, ".research-feed-child-label"), /display:\s*block/);
  assert.match(ruleBody(feedCss, ".research-feed-child-text"), /display:\s*-webkit-box/);

  // Nothing sits in the top-right corner under the controls' pill any more:
  // no status dot, unread dot, or float reserving room for them.
  for (const css of [feedCss, researchCss]) {
    assert.doesNotMatch(css, /research-feed-status|research-feed-card-unread|research-feed-child-icon/);
    assert.doesNotMatch(css, /float:\s*right/);
  }
  // The Queued and Stopped words are plain meta text; Not sent keeps its
  // error pill.
  assert.match(ruleBody(researchCss, ".research-msg-provenance,\n.research-msg-state"), /margin-right:\s*4\.5px/);
  assert.doesNotMatch(researchCss, /\.research-msg-pill\.is-(run|plain)/);
  assert.match(ruleBody(researchCss, ".research-msg-pill.is-error"), /background:/);
});

test("the running glyph pulses as the status dot did, except with reduced motion", () => {
  assert.match(
    ruleBody(feedCss, ".research-row-glyph-pulse"),
    /animation:\s*research-feed-pulse 1\.4s ease-in-out infinite/,
  );
  assert.match(ruleBody(feedCss, "@keyframes research-feed-pulse"), /50% \{\s*opacity:\s*0\.3;?/);
  assert.match(
    ruleBody(reducedMotionCss, ".app-shell.reduce-motion .research-row-glyph-pulse,\n.app-shell.reduce-motion .research-pulse"),
    /animation:\s*none/,
  );
  assert.match(
    ruleBody(reducedMotionCss, "  .research-row-glyph-pulse,\n  .research-pulse"),
    /animation:\s*none/,
  );
});

test("a saved link's URL and a card's URLs break anywhere, so they start on the glyph's line", () => {
  // The glyph is a float: a first word too long for the rest of the line
  // breaks beside it (overflow-wrap) instead of moving below it, and a URL,
  // which has no break points of its own, breaks between any characters.
  const url = ruleBody(postsCss, ".post-link-card-url");
  assert.match(url, /overflow-wrap:\s*anywhere/);
  assert.match(url, /word-break:\s*break-all/);
  assert.match(ruleBody(feedCss, ".research-feed-url"), /word-break:\s*break-all/);
  for (const selector of [".research-feed-card-title", ".research-feed-card-question", ".research-feed-child-text"]) {
    assert.match(ruleBody(feedCss, selector), /overflow-wrap:\s*anywhere/, selector);
  }
  assert.match(
    ruleBody(researchCss, ".research-msg-prompt .turn-markdown.research-prose,\n.research-msg-plain"),
    /overflow-wrap:\s*anywhere/,
  );
  // Not an inline box, whose line break after it would let the URL drop
  // below it.
  assert.doesNotMatch(ruleBody(feedCss, ".research-row-glyph"), /display:\s*inline/);
});
