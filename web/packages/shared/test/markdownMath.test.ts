import test from "ava";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { normalizeLatexMathDelimiters } from "../src/markdown/mathDelimiters.js";
import { baseRemarkPlugins, mathRemarkPlugins } from "../src/markdown/plugins.js";

// These cover the parse half of the math pipeline: delimiter normalization and
// the transcript tweaks, over mdast. The render half — MathJax SVG output, the
// injected container styles, and the inline (preview) renderer variant — needs
// react-markdown and a DOM and is tested in the client package.
interface TestNode {
  type: string;
  value?: string;
  children?: TestNode[];
  data?: { hName?: string };
}

const processor = unified().use(remarkParse).use(baseRemarkPlugins).use(mathRemarkPlugins);

function parse(source: string): TestNode {
  const document = normalizeLatexMathDelimiters(source);
  return processor.runSync(processor.parse(document), document) as unknown as TestNode;
}

function nodes(source: string): TestNode[] {
  const collected: TestNode[] = [];
  const walk = (node: TestNode) => {
    collected.push(node);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(parse(source));
  return collected;
}

function mathNodes(source: string): TestNode[] {
  return nodes(source).filter((node) => node.type === "math" || node.type === "inlineMath");
}

/** Text as a reader sees it: every literal value, math left as source. */
function textContent(source: string): string {
  return nodes(source)
    .filter((node) => node.type === "text" || node.type === "inlineCode" || node.type === "code")
    .map((node) => node.value ?? "")
    .join("");
}

test("inline TeX parses as an inline math node", (t) => {
  t.deepEqual(
    mathNodes("Euler: $e^{i\\pi}+1=0$").map((node) => [node.type, node.value]),
    [["inlineMath", "e^{i\\pi}+1=0"]],
  );
});

test("fenced display TeX parses as a block math node", (t) => {
  t.deepEqual(
    mathNodes("$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$").map((node) => [node.type, node.value]),
    [["math", "\\int_0^1 x^2\\,dx = \\frac{1}{3}"]],
  );
});

test("LaTeX bracket delimiters become block math", (t) => {
  const math = mathNodes(
    "\\[\n\\text{competitive deployment}\n\\rightarrow\n\\text{deep dependence}\n\\]",
  );
  t.is(math.length, 1);
  t.is(math[0]?.type, "math");
  t.is(textContent("\\[\nx^2\n\\]"), "");
});

test("LaTeX parenthesis delimiters become inline math", (t) => {
  t.deepEqual(
    mathNodes("Euler: \\(e^{i\\pi}+1=0\\).").map((node) => [node.type, node.value]),
    [["inlineMath", "e^{i\\pi}+1=0"]],
  );
});

// micromark only accepts $$ on its own lines as display math, but answers
// routinely put the whole thing on one line; the tweak promotes a paragraph
// that is exactly one $$-delimited node.
test("a standalone single-line $$…$$ paragraph is promoted to block math", (t) => {
  const math = mathNodes("$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$");
  t.is(math.length, 1);
  t.is(math[0]?.type, "math");
  // Promoted nodes carry the same hast shape mdast-util-math gives fenced math,
  // so remark-rehype and rehype-mathjax treat them identically.
  t.is(math[0]?.data?.hName, "pre");
  t.is(math[0]?.value, "\\int_0^1 x^2\\,dx = \\frac{1}{3}");
});

test("$$…$$ inside a sentence stays inline math", (t) => {
  t.deepEqual(
    mathNodes("mid $$a+b$$ sentence").map((node) => node.type),
    ["inlineMath"],
  );
});

test("dollar amounts in prose stay plain text", (t) => {
  const source = "The first costs $5 and the second $10 more.";
  t.deepEqual(mathNodes(source), []);
  t.is(textContent(source), source);
});

test("per-unit prices stay plain text", (t) => {
  const source = "about $3/M input and $15/M output";
  t.deepEqual(mathNodes(source), []);
  t.is(textContent(source), source);
});

test("TeX inside code spans and fences is left literal", (t) => {
  t.deepEqual(mathNodes("Use `$x^2$` in your prompt."), []);
  t.true(textContent("Use `$x^2$` in your prompt.").includes("$x^2$"));

  t.deepEqual(mathNodes("```\n$$a+b$$\n```"), []);
  t.true(textContent("```\n$$a+b$$\n```").includes("$$a+b$$"));

  t.deepEqual(mathNodes("Use `\\(x^2\\)` in your prompt."), []);
  t.true(textContent("Use `\\(x^2\\)` in your prompt.").includes("\\(x^2\\)"));

  t.deepEqual(mathNodes("```tex\n\\[\na+b\n\\]\n```"), []);
  t.true(textContent("```tex\n\\[\na+b\n\\]\n```").includes("\\["));
});

test("markdown without math produces no math nodes", (t) => {
  t.deepEqual(mathNodes("Just **bold** text."), []);
  t.is(textContent("Just **bold** text."), "Just bold text.");
});
