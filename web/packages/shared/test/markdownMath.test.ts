import test from "ava";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { normalizeLatexMathDelimiters } from "../src/markdown/mathDelimiters.js";
import { baseRemarkPlugins, loadMathPlugins } from "../src/markdown/plugins.js";

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

// remark-math loads once, behind the same dynamic import the client uses, and
// the resolved processor is reused across every test in this file.
const processorPromise = loadMathPlugins().then(({ remarkPlugins }) =>
  unified().use(remarkParse).use(baseRemarkPlugins).use(remarkPlugins),
);

async function parse(source: string): Promise<TestNode> {
  const processor = await processorPromise;
  const document = normalizeLatexMathDelimiters(source);
  return processor.runSync(processor.parse(document), document) as unknown as TestNode;
}

async function nodes(source: string): Promise<TestNode[]> {
  const collected: TestNode[] = [];
  const walk = (node: TestNode) => {
    collected.push(node);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(await parse(source));
  return collected;
}

async function mathNodes(source: string): Promise<TestNode[]> {
  return (await nodes(source)).filter((node) => node.type === "math" || node.type === "inlineMath");
}

/** Text as a reader sees it: every literal value, math left as source. */
async function textContent(source: string): Promise<string> {
  return (await nodes(source))
    .filter((node) => node.type === "text" || node.type === "inlineCode" || node.type === "code")
    .map((node) => node.value ?? "")
    .join("");
}

test("inline TeX parses as an inline math node", async (t) => {
  t.deepEqual(
    (await mathNodes("Euler: $e^{i\\pi}+1=0$")).map((node) => [node.type, node.value]),
    [["inlineMath", "e^{i\\pi}+1=0"]],
  );
});

test("fenced display TeX parses as a block math node", async (t) => {
  t.deepEqual(
    (await mathNodes("$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$")).map((node) => [
      node.type,
      node.value,
    ]),
    [["math", "\\int_0^1 x^2\\,dx = \\frac{1}{3}"]],
  );
});

test("LaTeX bracket delimiters become block math", async (t) => {
  const math = await mathNodes(
    "\\[\n\\text{competitive deployment}\n\\rightarrow\n\\text{deep dependence}\n\\]",
  );
  t.is(math.length, 1);
  t.is(math[0]?.type, "math");
  t.is(await textContent("\\[\nx^2\n\\]"), "");
});

test("LaTeX parenthesis delimiters become inline math", async (t) => {
  t.deepEqual(
    (await mathNodes("Euler: \\(e^{i\\pi}+1=0\\).")).map((node) => [node.type, node.value]),
    [["inlineMath", "e^{i\\pi}+1=0"]],
  );
});

// micromark only accepts $$ on its own lines as display math, but answers
// routinely put the whole thing on one line; the tweak promotes a paragraph
// that is exactly one $$-delimited node.
test("a standalone single-line $$…$$ paragraph is promoted to block math", async (t) => {
  const math = await mathNodes("$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$");
  t.is(math.length, 1);
  t.is(math[0]?.type, "math");
  // Promoted nodes carry the same hast shape mdast-util-math gives fenced math,
  // so remark-rehype and rehype-mathjax treat them identically.
  t.is(math[0]?.data?.hName, "pre");
  t.is(math[0]?.value, "\\int_0^1 x^2\\,dx = \\frac{1}{3}");
});

test("$$…$$ inside a sentence stays inline math", async (t) => {
  t.deepEqual(
    (await mathNodes("mid $$a+b$$ sentence")).map((node) => node.type),
    ["inlineMath"],
  );
});

test("dollar amounts in prose stay plain text", async (t) => {
  const source = "The first costs $5 and the second $10 more.";
  t.deepEqual(await mathNodes(source), []);
  t.is(await textContent(source), source);
});

test("per-unit prices stay plain text", async (t) => {
  const source = "about $3/M input and $15/M output";
  t.deepEqual(await mathNodes(source), []);
  t.is(await textContent(source), source);
});

test("TeX inside code spans and fences is left literal", async (t) => {
  t.deepEqual(await mathNodes("Use `$x^2$` in your prompt."), []);
  t.true((await textContent("Use `$x^2$` in your prompt.")).includes("$x^2$"));

  t.deepEqual(await mathNodes("```\n$$a+b$$\n```"), []);
  t.true((await textContent("```\n$$a+b$$\n```")).includes("$$a+b$$"));

  t.deepEqual(await mathNodes("Use `\\(x^2\\)` in your prompt."), []);
  t.true((await textContent("Use `\\(x^2\\)` in your prompt.")).includes("\\(x^2\\)"));

  t.deepEqual(await mathNodes("```tex\n\\[\na+b\n\\]\n```"), []);
  t.true((await textContent("```tex\n\\[\na+b\n\\]\n```")).includes("\\["));
});

test("markdown without math produces no math nodes", async (t) => {
  t.deepEqual(await mathNodes("Just **bold** text."), []);
  t.is(await textContent("Just **bold** text."), "Just bold text.");
});
