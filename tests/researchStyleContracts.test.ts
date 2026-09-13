import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles", "features");
const surfaceCss = readFileSync(join(stylesDirectory, "research-surface.css"), "utf8");
const researchCss = readFileSync(join(stylesDirectory, "research.css"), "utf8");
const journalCss = readFileSync(join(stylesDirectory, "journal.css"), "utf8");

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("research summaries get typography only from the shared surface recipe", () => {
  const summary = ruleBody(surfaceCss, ".research-summary-text");
  assert.match(summary, /font-size:\s*var\(--research-summary-font-size\)/);
  assert.match(summary, /line-height:\s*var\(--research-summary-line-height\)/);

  const homePlacement = ruleBody(journalCss, ".recent-query-recap");
  assert.doesNotMatch(homePlacement, /font(?:-size|-style|-weight)?\s*:/);
  assert.doesNotMatch(homePlacement, /line-height\s*:/);

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
    `${researchCss}\n${journalCss}`,
    /--research-(?:reading-(?:body|meta)|answer-font-delta)/,
  );
});

test("shared tweet and attachment recipes do not depend on Home CSS", () => {
  assert.match(surfaceCss, /\.journal-tweet\s*\{/);
  assert.match(surfaceCss, /\.research-message-attachments\.has-prompt\s*\{/);
  const tweet = ruleBody(surfaceCss, ".journal-tweet");
  assert.match(tweet, /max-width:\s*var\(--research-feed-max-width\)/);
  const attachment = ruleBody(surfaceCss, ".research-message-attachment");
  assert.match(attachment, /width:\s*min\(100%, var\(--research-feed-max-width\)\)/);
  assert.match(attachment, /border:\s*1px solid var\(--surface-border-default\)/);
  assert.match(attachment, /border-radius:\s*12px/);
  const tweetStats = ruleBody(surfaceCss, ".journal-tweet-stats");
  assert.match(tweetStats, /align-items:\s*center/);
  assert.match(tweetStats, /line-height:\s*1/);
  assert.doesNotMatch(
    ruleBody(surfaceCss, ".research-message-attachments.has-prompt"),
    /border-top/,
  );
  assert.doesNotMatch(journalCss, /\.research-message-attachments\.has-prompt\s*\{/);
  const journalColumn = ruleBody(journalCss, ".journal-column");
  assert.match(journalColumn, /width:\s*100%/);
  assert.match(
    journalColumn,
    /max-width:\s*calc\(var\(--research-feed-max-width\) \+ 2 \* var\(--journal-content-padding\)\)/,
  );
});
