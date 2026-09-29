import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown, {
  transcriptMathPluginsReady,
} from "../src/components/TranscriptMarkdown";
import {
  MAX_WIKILINK_CHARS,
  escapeWikilinkTablePipes,
  stripWikilinks,
} from "../src/lib/wikilinks";

function render(text: string, inline = false) {
  return renderToStaticMarkup(createElement(TranscriptMarkdown, { text, inline }));
}

const TEXT = (term: string, label = term) => label;

// Before the math chunk resolves the renderer runs the base plugin list; the
// wikilink transform must be present there too, or links appear only after
// the chunk swaps in.
test("wikilinks render before the math plugins are ready", () => {
  const html = render("See [[Rust]].");
  assert.ok(html.includes(TEXT("Rust")), html);
});

await transcriptMathPluginsReady;

test("a legacy wikilink renders as plain text without a link", () => {
  const html = render("See [[Rust]] today.");
  assert.ok(html.includes(`See ${TEXT("Rust")} today.`), html);
  assert.equal(html.includes("[["), false);
  assert.equal(html.includes("href="), false);
  assert.doesNotMatch(html, /<a|data-wikilink|tabindex/);
});

test("a legacy alias renders only its display text", () => {
  const html = render("Runs on [[Tokio|the tokio]] runtime.");
  assert.ok(html.includes(TEXT("Tokio", "the tokio")), html);
});

test("terms and aliases are trimmed", () => {
  const html = render("[[ Rust | the Rust language ]]");
  assert.ok(html.includes(TEXT("Rust", "the Rust language")), html);
});

test("legacy markers in lists become plain text", () => {
  const html = render("- [[Alpha]]: first\n- [[Beta|betas]]: second\n- plain");
  assert.ok(html.includes(`<li>${TEXT("Alpha")}: first</li>`), html);
  assert.ok(html.includes(`<li>${TEXT("Beta", "betas")}: second</li>`), html);
  assert.ok(html.includes("<li>plain</li>"), html);
});

test("wikilinks survive inside emphasis and table cells", () => {
  const html = render("**[[Bold term]]** and _[[Italic term]]_");
  assert.ok(html.includes(`<strong>${TEXT("Bold term")}</strong>`), html);
  assert.ok(html.includes(`<em>${TEXT("Italic term")}</em>`), html);
  const table = render("| a | b |\n| - | - |\n| [[Cell]] | x |");
  assert.ok(table.includes(`<td>${TEXT("Cell")}</td>`), table);
});

// GFM splits table cells on `|` before inline parsing, so an alias wikilink
// on a row would otherwise land in two cells and push the rest of the row
// over by one, dropping the last cell. The renderer escapes the pipe first.
test("alias wikilinks keep their table cell intact", () => {
  const html = render(
    "| Network | Proof | Cost |\n|---|---|---|\n| [[X (Twitter)|X]] | Strong | Weak |\n| Plain [[Bluesky|Bsky]] and [[Trusted Verifier|Trusted Verifiers]] | a | b |",
  );
  assert.ok(html.includes(`<td>${TEXT("X (Twitter)", "X")}</td><td>Strong</td><td>Weak</td>`), html);
  assert.ok(
    html.includes(
      `<td>Plain ${TEXT("Bluesky", "Bsky")} and ${TEXT("Trusted Verifier", "Trusted Verifiers")}</td><td>a</td><td>b</td>`,
    ),
    html,
  );
  assert.equal(html.includes("[["), false);
  assert.equal(html.includes("]]"), false);
});

test("a pipe the agent already escaped on a table row is not escaped twice", () => {
  const html = render("| a | b |\n|---|---|\n| [[X (Twitter)\\|X]] | c |");
  assert.ok(html.includes(`<td>${TEXT("X (Twitter)", "X")}</td><td>c</td>`), html);
});

test("escapeWikilinkTablePipes only touches table rows outside code", () => {
  assert.equal(escapeWikilinkTablePipes("Runs on [[Tokio|the tokio]] runtime."), "Runs on [[Tokio|the tokio]] runtime.");
  assert.equal(escapeWikilinkTablePipes("| [[A|a]] | x |"), "| [[A\\|a]] | x |");
  assert.equal(escapeWikilinkTablePipes("[[A|a]] | x"), "[[A\\|a]] | x");
  assert.equal(escapeWikilinkTablePipes("| [[A\\|a]] | x |"), "| [[A\\|a]] | x |");
  assert.equal(escapeWikilinkTablePipes("| [[A]] | [[B|b]] |"), "| [[A]] | [[B\\|b]] |");
  const fenced = "```\n| [[A|a]] | x |\n```\n| [[B|b]] | y |";
  assert.equal(escapeWikilinkTablePipes(fenced), "```\n| [[A|a]] | x |\n```\n| [[B\\|b]] | y |");
  assert.equal(escapeWikilinkTablePipes("    | [[A|a]] | x |"), "    | [[A|a]] | x |");
  const untouched = "no pipes here [[A]]";
  assert.equal(escapeWikilinkTablePipes(untouched), untouched);
});

test("code, URLs, and existing links stay literal", () => {
  const html = render(
    "`arr[[0]]` and\n\n```\n[[Not a link]]\n```\n\n[text [[x]]](https://example.com/[[y]])",
  );
  assert.equal(html.includes("research-wikilink"), false, html);
  assert.ok(html.includes("arr[[0]]"), html);
  assert.ok(html.includes("[[Not a link]]"), html);
});

test("malformed markers stay literal text", () => {
  for (const source of [
    "[[]]",
    "[[ ]]",
    "[[unclosed",
    "[[two|pipes|here]]",
    "[[multi\nline]]",
    "[[a]b]]",
    `[[${"x".repeat(MAX_WIKILINK_CHARS + 1)}]]`,
  ]) {
    const html = render(source);
    assert.equal(html.includes("research-wikilink"), false, source);
  }
  // An extra opener is a literal bracket in front of a real link.
  assert.ok(render("[[[Term]]").includes(`[${TEXT("Term")}`));
});

test("the inline (preview) variant renders legacy wikilinks as plain text", () => {
  const html = render("- [[Alpha]] leads", true);
  assert.ok(html.includes(TEXT("Alpha")), html);
  assert.equal(html.includes("<li>"), false);
});

test("stripWikilinks keeps only display text and mirrors the parser", () => {
  assert.equal(stripWikilinks("no links"), "no links");
  assert.equal(
    stripWikilinks("Use [[Rust]] and [[Tokio|tokio's]] runtime."),
    "Use Rust and tokio's runtime.",
  );
  assert.equal(stripWikilinks("[[ spaced term ]]"), "spaced term");
  assert.equal(stripWikilinks("[[Term| ]]"), "Term");
  assert.equal(stripWikilinks("[[[Term]]"), "[Term");
  assert.equal(stripWikilinks("[[[[Term]]"), "[[Term");
  for (const literal of ["[[]]", "[[ ]]", "[[unclosed", "[[two|pipes|here]]", "[[a]b]]"]) {
    assert.equal(stripWikilinks(literal), literal);
  }
});
