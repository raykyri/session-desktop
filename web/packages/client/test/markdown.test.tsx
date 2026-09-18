// The one Markdown renderer (`08-design-system-and-styling.md` §5).
//
// What is worth pinning here is the behavior that is not react-markdown's:
// wikilinks resolving through context, destinations passing `safeHref`, the
// oversize policy, and TeX staying readable as source until the math chunk
// lands.

import { cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import {
  MARKDOWN_CHAR_LIMIT,
  OVERSIZED_MARKDOWN_POLICY,
  ResearchMarkdown,
  WikilinkActionsProvider,
  resetMathPluginsForTests,
  sourceMayContainMath,
} from "../src/features/markdown/index.js";

test.afterEach(() => {
  cleanup();
});

test.serial("a wikilink renders as a link and activates through context", (t) => {
  const activated: string[] = [];
  render(
    <WikilinkActionsProvider
      actions={{
        resolve: (term) => (term === "Collective memory" ? "ready" : null),
        activate: (term) => activated.push(term),
        interactive: true,
      }}
    >
      <ResearchMarkdown markdown="Shared recall is [[Collective memory]] at scale." />
    </WikilinkActionsProvider>,
  );

  const link = screen.getByRole("link", { name: "Collective memory" });
  t.is(link.getAttribute("data-wikilink"), "Collective memory");
  t.true(link.className.includes("is-ready"));
  // No destination: a wikilink is an action, not a URL.
  t.is(link.getAttribute("href"), null);
  link.click();
  t.deepEqual(activated, ["Collective memory"]);
});

test.serial("without a provider a wikilink is inert but still reads as linked", (t) => {
  render(<ResearchMarkdown markdown="See [[Memory palace]]." />);
  const link = screen.getByText("Memory palace");
  t.is(link.getAttribute("data-wikilink"), "Memory palace");
  t.is(link.getAttribute("title"), null);
});

test.serial("safeHref gates every destination the model wrote", (t) => {
  render(
    <ResearchMarkdown markdown="[ok](https://example.com/a) and [bad](javascript:alert(1))" />,
  );
  const safe = screen.getByRole("link", { name: "ok" });
  t.is(safe.getAttribute("href"), "https://example.com/a");
  t.is(safe.getAttribute("target"), "_blank");
  t.is(safe.getAttribute("rel"), "noopener noreferrer");
  // The rejected destination keeps its text and loses its link.
  t.is(screen.queryByRole("link", { name: "bad" }), null);
  t.truthy(screen.getByText("bad"));
});

test.serial("a remote image is never fetched", (t) => {
  render(<ResearchMarkdown markdown="![a chart](https://tracker.example/pixel.png)" />);
  t.is(document.querySelector("img"), null);
  t.truthy(screen.getByRole("link", { name: "Open image: a chart" }));
});

test.serial("an image marker collapses to an inert chip", (t) => {
  render(<ResearchMarkdown markdown="Before [Image: /tmp/shot.png] after" />);
  t.true((document.body.textContent ?? "").includes("[Image]"));
  t.is(document.querySelector("img"), null);
});

test.serial("oversized markdown falls back to capped plain text", (t) => {
  const source = "x".repeat(MARKDOWN_CHAR_LIMIT + 10);
  render(<ResearchMarkdown markdown={source} oversized={OVERSIZED_MARKDOWN_POLICY} />);
  const pre = document.querySelector("pre");
  t.truthy(pre);
  t.true(pre?.className.includes("research-plaintext"));
  // Under the display cap, so the whole source is shown without a notice.
  t.is(pre?.textContent?.length, source.length);
  t.is(document.querySelector("p"), null);
});

test.serial("the plain-text fallback is itself truncated with a notice", (t) => {
  const source = "y".repeat(50);
  render(
    <ResearchMarkdown
      markdown={source}
      oversized={{ maxCharacters: 10, maxDisplayCharacters: 20 }}
    />,
  );
  const text = document.querySelector("pre")?.textContent ?? "";
  t.true(text.startsWith("y".repeat(20)));
  t.true(text.includes("truncated: showing 20 of 50 characters"));
});

test.serial("TeX renders as its literal source until the math chunk lands", (t) => {
  resetMathPluginsForTests();
  render(<ResearchMarkdown markdown="Euler wrote $e^{i\\pi}+1=0$ here." />);
  // The base plugin list has no remark-math, so the dollars are ordinary text.
  t.true((document.body.textContent ?? "").includes("$e^{i\\pi}+1=0$"));
  t.is(document.querySelector("mjx-container"), null);
  // The chunk is requested only for a source that looks like it has TeX in it.
  t.true(sourceMayContainMath("$x$"));
  t.false(sourceMayContainMath("plain prose"));
});

test.serial("the variant chooses the typography, not the layout root", (t) => {
  const { container } = render(<ResearchMarkdown markdown="hello" variant="summary" />);
  t.true(container.firstElementChild?.className.includes("research-summary-text"));
  cleanup();
  const compact = render(<ResearchMarkdown markdown="hello" variant="compact" />);
  t.true(compact.container.firstElementChild?.className.includes("research-prose--compact"));
});

test.serial("inline mode drops block wrappers and keeps inline formatting", (t) => {
  const { container } = render(<ResearchMarkdown markdown={"# Heading\n\nwith **bold**"} inline />);
  t.is(container.querySelector("h1"), null);
  t.truthy(container.querySelector("strong"));
});

test.serial("an aliased wikilink survives a GFM table cell", (t) => {
  render(
    <ResearchMarkdown
      markdown={"| Term | Note |\n| --- | --- |\n| [[Collective memory|recall]] | shared |\n"}
    />,
  );
  // Two cells, not three: the alias pipe was escaped before parsing.
  t.is(document.querySelectorAll("tbody td").length, 2);
  t.truthy(screen.getByText("recall"));
});
