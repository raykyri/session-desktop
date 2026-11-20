import test from "ava";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { baseRemarkPlugins } from "../src/markdown/plugins.js";
import {
  escapeWikilinkTablePipes,
  MAX_WIKILINK_CHARS,
  stripWikilinks,
} from "../src/markdown/wikilinks.js";

// The client renders these trees with react-markdown; here they are serialized
// by hand so the transform is exercised over mdast without a DOM. The markup is
// the subset react-markdown produces for these nodes, minus the interaction
// attributes (`role`, `tabindex`) the client's link component adds.
interface TestNode {
  type: string;
  value?: string;
  url?: string;
  children?: TestNode[];
  data?: { hProperties?: { className?: string[]; dataWikilink?: string } };
}

function serializeChildren(node: TestNode): string {
  return (node.children ?? []).map(serialize).join("");
}

function serialize(node: TestNode): string {
  switch (node.type) {
    case "text":
      return node.value ?? "";
    case "inlineCode":
      return `<code>${node.value ?? ""}</code>`;
    case "code":
      return `<pre><code>${node.value ?? ""}</code></pre>`;
    case "paragraph":
      return `<p>${serializeChildren(node)}</p>`;
    case "strong":
      return `<strong>${serializeChildren(node)}</strong>`;
    case "emphasis":
      return `<em>${serializeChildren(node)}</em>`;
    case "list":
      return `<ul>${serializeChildren(node)}</ul>`;
    case "listItem":
      return `<li>${(node.children ?? [])
        .map((child) => (child.type === "paragraph" ? serializeChildren(child) : serialize(child)))
        .join("")}</li>`;
    case "table":
      return `<table>${serializeChildren(node)}</table>`;
    case "tableRow":
      return `<tr>${serializeChildren(node)}</tr>`;
    case "tableCell":
      return `<td>${serializeChildren(node)}</td>`;
    case "link":
      return `<a href="${node.url ?? ""}">${serializeChildren(node)}</a>`;
    default:
      return serializeChildren(node);
  }
}

// The base plugin list is what the client renders with before the math chunk
// resolves; the wikilink transform must be in it, or links would appear only
// after the swap.
const processor = unified().use(remarkParse).use(baseRemarkPlugins);

function render(source: string): string {
  const document = escapeWikilinkTablePipes(source);
  return serialize(processor.runSync(processor.parse(document), document) as unknown as TestNode);
}

const TEXT = (term: string, label = term) => label;

test("a legacy wikilink renders as plain text without a link", (t) => {
  const html = render("See [[Rust]] today.");
  t.true(html.includes(`See ${TEXT("Rust")} today.`), html);
  t.is(html.includes("[["), false);
  t.is(html.includes("href="), false);
  t.notRegex(html, /<a|data-wikilink|tabindex/);
});

test("a legacy alias renders only its display text", (t) => {
  const html = render("Runs on [[Tokio|the tokio]] runtime.");
  t.true(html.includes(TEXT("Tokio", "the tokio")), html);
});

test("terms and aliases are trimmed", (t) => {
  const html = render("[[ Rust | the Rust language ]]");
  t.true(html.includes(TEXT("Rust", "the Rust language")), html);
});

test("legacy markers in lists become plain text", (t) => {
  const html = render("- [[Alpha]]: first\n- [[Beta|betas]]: second\n- plain");
  t.true(html.includes(`<li>${TEXT("Alpha")}: first</li>`), html);
  t.true(html.includes(`<li>${TEXT("Beta", "betas")}: second</li>`), html);
  t.true(html.includes("<li>plain</li>"), html);
});

test("preserves wikilink syntax within formatted text and Markdown table cells", (t) => {
  const html = render("**[[Bold term]]** and _[[Italic term]]_");
  t.true(html.includes(`<strong>${TEXT("Bold term")}</strong>`), html);
  t.true(html.includes(`<em>${TEXT("Italic term")}</em>`), html);
  const table = render("| a | b |\n| - | - |\n| [[Cell]] | x |");
  t.true(table.includes(`<td>${TEXT("Cell")}</td>`), table);
});

// GFM splits table cells on `|` before inline parsing, so an alias wikilink
// on a row would otherwise land in two cells and push the rest of the row
// over by one, dropping the last cell. The renderer escapes the pipe first.
test("alias wikilinks keep their table cell intact", (t) => {
  const html = render(
    "| Network | Proof | Cost |\n|---|---|---|\n| [[X (Twitter)|X]] | Strong | Weak |\n| Plain [[Bluesky|Bsky]] and [[Trusted Verifier|Trusted Verifiers]] | a | b |",
  );
  t.true(html.includes(`<td>${TEXT("X (Twitter)", "X")}</td><td>Strong</td><td>Weak</td>`), html);
  t.true(
    html.includes(
      `<td>Plain ${TEXT("Bluesky", "Bsky")} and ${TEXT("Trusted Verifier", "Trusted Verifiers")}</td><td>a</td><td>b</td>`,
    ),
    html,
  );
  t.is(html.includes("[["), false);
  t.is(html.includes("]]"), false);
});

test("a pipe the agent already escaped on a table row is not escaped twice", (t) => {
  const html = render("| a | b |\n|---|---|\n| [[X (Twitter)\\|X]] | c |");
  t.true(html.includes(`<td>${TEXT("X (Twitter)", "X")}</td><td>c</td>`), html);
});

test("escapeWikilinkTablePipes only touches table rows outside code", (t) => {
  t.is(
    escapeWikilinkTablePipes("Runs on [[Tokio|the tokio]] runtime."),
    "Runs on [[Tokio|the tokio]] runtime.",
  );
  t.is(escapeWikilinkTablePipes("| [[A|a]] | x |"), "| [[A\\|a]] | x |");
  t.is(escapeWikilinkTablePipes("[[A|a]] | x"), "[[A\\|a]] | x");
  t.is(escapeWikilinkTablePipes("| [[A\\|a]] | x |"), "| [[A\\|a]] | x |");
  t.is(escapeWikilinkTablePipes("| [[A]] | [[B|b]] |"), "| [[A]] | [[B\\|b]] |");
  const fenced = "```\n| [[A|a]] | x |\n```\n| [[B|b]] | y |";
  t.is(escapeWikilinkTablePipes(fenced), "```\n| [[A|a]] | x |\n```\n| [[B\\|b]] | y |");
  t.is(escapeWikilinkTablePipes("    | [[A|a]] | x |"), "    | [[A|a]] | x |");
  const untouched = "no pipes here [[A]]";
  t.is(escapeWikilinkTablePipes(untouched), untouched);
});

test("code, URLs, and existing links stay literal", (t) => {
  const html = render(
    "`arr[[0]]` and\n\n```\n[[Not a link]]\n```\n\n[text [[x]]](https://example.com/[[y]])",
  );
  t.is(html.includes("research-wikilink"), false, html);
  t.true(html.includes("arr[[0]]"), html);
  t.true(html.includes("[[Not a link]]"), html);
});

test("malformed markers stay literal text", (t) => {
  for (const source of [
    "[[]]",
    "[[ ]]",
    "[[unclosed",
    "[[two|pipes|here]]",
    "[[multi\nline]]",
    "[[a]b]]",
    `[[${"x".repeat(MAX_WIKILINK_CHARS + 1)}]]`,
  ]) {
    t.is(render(source).includes("research-wikilink"), false, source);
  }
  // An extra opener is a literal bracket in front of a real link.
  t.true(render("[[[Term]]").includes(`[${TEXT("Term")}`));
});

test("stripWikilinks keeps only display text and mirrors the parser", (t) => {
  t.is(stripWikilinks("no links"), "no links");
  t.is(
    stripWikilinks("Use [[Rust]] and [[Tokio|tokio's]] runtime."),
    "Use Rust and tokio's runtime.",
  );
  t.is(stripWikilinks("[[ spaced term ]]"), "spaced term");
  t.is(stripWikilinks("[[Term| ]]"), "Term");
  t.is(stripWikilinks("[[[Term]]"), "[Term");
  t.is(stripWikilinks("[[[[Term]]"), "[[Term");
  for (const literal of ["[[]]", "[[ ]]", "[[unclosed", "[[two|pipes|here]]", "[[a]b]]"]) {
    t.is(stripWikilinks(literal), literal);
  }
});

// The cases `wikilink_terms` pins in `src-tauri/src/wikilinks.rs`; this is the
// list that becomes a page's links and a source's co-occurring terms.
