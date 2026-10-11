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
const turnPaneCss = readFileSync(join(stylesDirectory, "turn-pane.css"), "utf8");

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

  const turnPane = ruleBody(turnPaneCss, ".turn-pane");
  assert.match(turnPane, /--fs-base:[^;]+var\(--font-ui-size-offset\)/s);

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

test("a feed row's dot takes a float at the start of its text, so only the first line wraps around it", () => {
  // The content is block flow: floats take no part in a flex layout.
  const content = ruleBody(feedCss, ".research-feed-card-content");
  assert.match(content, /display:\s*flow-root/);
  assert.doesNotMatch(content, /flex|gap:/);
  assert.match(ruleBody(feedCss, ".research-feed-card-content > * + *"), /margin-top:\s*2px/);

  const spacer = ruleBody(
    feedCss,
    ".research-feed-card:has(> .research-feed-status, > .research-feed-card-unread)\n  .research-feed-card-content::before,\n.research-feed-child:has(> .research-feed-status) .research-feed-child-label::before",
  );
  assert.match(spacer, /float:\s*right/);
  assert.match(spacer, /width:\s*12px/);
  assert.match(spacer, /height:\s*14px/);
  assert.match(spacer, /content:\s*""/);
  // The float is in a block inside the clamped box: WebKit does not float a
  // -webkit-box's own children.
  assert.match(ruleBody(feedCss, ".research-feed-child-label"), /display:\s*block/);
  assert.match(ruleBody(feedCss, ".research-feed-child-text"), /display:\s*-webkit-box/);

  // An embed that opens the card is set beside the float.
  assert.match(
    ruleBody(
      feedCss,
      ".research-feed-card:has(> .research-feed-status, > .research-feed-card-unread)\n  .research-message-attachments:not(.has-prompt)",
    ),
    /display:\s*flow-root/,
  );

  // No row pads all of its text for the dot.
  assert.doesNotMatch(feedCss, /:has\(> \.research-feed-status[^{]*\{\s*padding-right/);
});
