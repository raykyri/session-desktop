import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import test from "ava";

import { setTrpcClient } from "../src/api/trpc.js";
import { ResearchMarkdown } from "../src/features/markdown/ResearchMarkdown.js";
import {
  researchTextProjection,
  rangeForTextOffsets,
} from "../src/features/research/selection/dom.js";

import { createTrpcStub } from "./trpcStub.js";

test.afterEach.always(() => cleanup());
test.serial("web widgets preserve source/projection and never grant scripts", async (t) => {
  const stub = createTrpcStub({
    "artifacts.prepareWidget": {
      url: "http://artifacts.localhost:8787/w/token",
      expiresAt: Date.now() + 60_000,
    },
  });
  setTrpcClient(stub.client);
  const markdown =
    'Before.\n\n```session-html title="Chart"\n<p>Static chart</p><script>bad()</script>\n```\n\nAfter.';
  const { container } = render(<ResearchMarkdown widgets markdown={markdown} />);
  await waitFor(() => {
    if (!container.querySelector("iframe")) throw new Error("preview pending");
  });
  const frame = container.querySelector("iframe")!;
  t.is(frame.getAttribute("sandbox"), "");
  const projection = researchTextProjection(container);
  t.false(projection.includes("Chart"));
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  t.truthy(screen.getByText("<p>Static chart</p><script>bad()</script>"));
  t.is(container.querySelector("iframe"), frame);
  t.is(researchTextProjection(container), projection);
  const start = projection.indexOf("After.");
  t.is(rangeForTextOffsets(container, start, start + 6)?.toString(), "After.");
  t.deepEqual(stub.calls[0]?.input, { html: "<p>Static chart</p><script>bad()</script>" });
});
test.serial("ordinary Markdown and incomplete fences never mint previews", (t) => {
  const stub = createTrpcStub();
  setTrpcClient(stub.client);
  render(<ResearchMarkdown markdown={"```session-html\n<p>code</p>\n```"} />);
  render(<ResearchMarkdown widgets markdown={"```session-html\n<p>incomplete</p>"} />);
  t.is(stub.calls.length, 0);
  t.is(document.querySelector("iframe"), null);
});
