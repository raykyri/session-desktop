import test from "ava";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { baseRemarkPlugins } from "../src/markdown/plugins.js";
import {
  escapeWikilinkTablePipes,
  MAX_WIKILINK_CHARS,
  splitWikilinkText,
  stripWikilinks,
  wikilinkTerms,
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
    case "wikilink": {
      const properties = node.data?.hProperties ?? {};
      const className = (properties.className ?? []).join(" ");
      return `<a class="${className}" data-wikilink="${properties.dataWikilink ?? ""}">${serializeChildren(node)}</a>`;
    }
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

const LINK = (term: string, label = term) =>
  `<a class="research-wikilink" data-wikilink="${term}">${label}</a>`;

test("a bare wikilink renders as a destination-less link", (t) => {
  const html = render("See [[Rust]] today.");
  t.true(html.includes(`See ${LINK("Rust")} today.`), html);
  t.is(html.includes("[["), false);
  t.is(html.includes("href="), false);
});

test("an alias shows the alias and keeps the canonical term", (t) => {
  const html = render("Runs on [[Tokio|the tokio]] runtime.");
  t.true(html.includes(LINK("Tokio", "the tokio")), html);
});

test("terms and aliases are trimmed", (t) => {
  const html = render("[[ Rust | the Rust language ]]");
  t.true(html.includes(LINK("Rust", "the Rust language")), html);
});

test("every item in a list links independently", (t) => {
  const html = render("- [[Alpha]]: first\n- [[Beta|betas]]: second\n- plain");
  t.true(html.includes(`<li>${LINK("Alpha")}: first</li>`), html);
  t.true(html.includes(`<li>${LINK("Beta", "betas")}: second</li>`), html);
  t.true(html.includes("<li>plain</li>"), html);
});

test("wikilinks survive inside emphasis and table cells", (t) => {
  const html = render("**[[Bold term]]** and _[[Italic term]]_");
  t.true(html.includes(`<strong>${LINK("Bold term")}</strong>`), html);
  t.true(html.includes(`<em>${LINK("Italic term")}</em>`), html);
  const table = render("| a | b |\n| - | - |\n| [[Cell]] | x |");
  t.true(table.includes(`<td>${LINK("Cell")}</td>`), table);
});

// GFM splits table cells on `|` before inline parsing, so an alias wikilink
// on a row would otherwise land in two cells and push the rest of the row
// over by one, dropping the last cell. The renderer escapes the pipe first.
test("alias wikilinks keep their table cell intact", (t) => {
  const html = render(
    "| Network | Proof | Cost |\n|---|---|---|\n| [[X (Twitter)|X]] | Strong | Weak |\n| Plain [[Bluesky|Bsky]] and [[Trusted Verifier|Trusted Verifiers]] | a | b |",
  );
  t.true(html.includes(`<td>${LINK("X (Twitter)", "X")}</td><td>Strong</td><td>Weak</td>`), html);
  t.true(
    html.includes(
      `<td>Plain ${LINK("Bluesky", "Bsky")} and ${LINK("Trusted Verifier", "Trusted Verifiers")}</td><td>a</td><td>b</td>`,
    ),
    html,
  );
  t.is(html.includes("[["), false);
  t.is(html.includes("]]"), false);
});

test("a pipe the agent already escaped on a table row is not escaped twice", (t) => {
  const html = render("| a | b |\n|---|---|\n| [[X (Twitter)\\|X]] | c |");
  t.true(html.includes(`<td>${LINK("X (Twitter)", "X")}</td><td>c</td>`), html);
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
  t.true(render("[[[Term]]").includes(`[${LINK("Term")}`));
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

test("splitWikilinkText returns null when a text node has nothing to link", (t) => {
  t.is(splitWikilinkText("plain"), null);
  t.is(splitWikilinkText("[[ ]]"), null);
  const nodes = splitWikilinkText("a [[B]] c");
  t.deepEqual(
    nodes?.map((node) => node.type),
    ["text", "wikilink", "text"],
  );
});

// The cases `wikilink_terms` pins in `src-tauri/src/wikilinks.rs`; this is the
// list that becomes a page's links and a source's co-occurring terms.
test("wikilinkTerms collects canonical terms once, in order of appearance", (t) => {
  t.deepEqual(wikilinkTerms("[[Rust]] and [[Tokio|tokio's]] then [[Rust]] again, [[bad|x|y]]"), [
    "Rust",
    "Tokio",
  ]);
  t.deepEqual(wikilinkTerms("no links"), []);
  t.deepEqual(wikilinkTerms(""), []);
});

test("wikilinkTerms takes the term, not the display text, and trims it", (t) => {
  t.deepEqual(wikilinkTerms("[[ Canonical name | as written ]]"), ["Canonical name"]);
  // An alias that differs only in wording is still one term.
  t.deepEqual(wikilinkTerms("[[Rust|Rust's]] and [[Rust|rust]]"), ["Rust"]);
});

test("wikilinkTerms ignores anything the grammar rejects", (t) => {
  const long = "x".repeat(MAX_WIKILINK_CHARS + 1);
  for (const source of [
    "[[]]",
    "[[ ]]",
    "[[unclosed",
    "[[two|pipes|here]]",
    "[[multi\nline]]",
    "[[a]b]]",
    `[[${long}]]`,
  ]) {
    t.deepEqual(wikilinkTerms(source), [], source);
  }
  // An extra opener is a literal bracket in front of a real link.
  t.deepEqual(wikilinkTerms("[[[Term]]"), ["Term"]);
});
