import { createHash } from "node:crypto";

import { SESSION_WIDGET_DOWNLOAD_POLICY, sessionWidgetDownloadDocument } from "@session/shared";
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
  const html = "<p>Static chart</p><script>bad()</script>";
  const markdown = `Before.\n\n\`\`\`session-html title="Chart"\n${html}\n\`\`\`\n\nAfter.`;
  const { container } = render(<ResearchMarkdown widgetNodeId="node-1" markdown={markdown} />);
  await waitFor(() => {
    if (!container.querySelector("iframe")) throw new Error("preview pending");
  });
  const frame = container.querySelector("iframe")!;
  t.is(frame.getAttribute("sandbox"), "");
  const projection = researchTextProjection(container);
  t.false(projection.includes("Chart"));
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  t.truthy(screen.getByText(html));
  t.is(container.querySelector("iframe"), frame);
  t.is(researchTextProjection(container), projection);
  const start = projection.indexOf("After.");
  t.is(rangeForTextOffsets(container, start, start + 6)?.toString(), "After.");
  // The server resolves the HTML from the stored answer; the client names the
  // answer and the block's hash, never sends HTML.
  t.deepEqual(stub.calls[0]?.input, {
    nodeId: "node-1",
    sha256: createHash("sha256").update(html, "utf8").digest("hex"),
  });
});

test.serial("ordinary Markdown and incomplete fences never mint previews", (t) => {
  const stub = createTrpcStub();
  setTrpcClient(stub.client);
  render(<ResearchMarkdown markdown={"```session-html\n<p>code</p>\n```"} />);
  render(
    <ResearchMarkdown widgetNodeId="node-1" markdown={"```session-html\n<p>incomplete</p>"} />,
  );
  t.is(stub.calls.length, 0);
  t.is(document.querySelector("iframe"), null);
});

test.serial("with widgets off a session-html block is ordinary projected code", (t) => {
  const { container } = render(
    <ResearchMarkdown markdown={"Intro.\n\n```session-html\n<p>code</p>\n```"} />,
  );
  t.is(container.querySelector("[data-research-widget]"), null);
  t.true(researchTextProjection(container).includes("<p>code</p>"));
});

test("downloaded widget files carry the static policy and no live http-equiv", (t) => {
  const file = sessionWidgetDownloadDocument(
    '<meta HTTP-EQUIV="refresh" content="0;url=https://bad.invalid"><p>x</p>',
  );
  t.true(
    file.includes(
      `<meta http-equiv="Content-Security-Policy" content="${SESSION_WIDGET_DOWNLOAD_POLICY}">`,
    ),
  );
  t.true(SESSION_WIDGET_DOWNLOAD_POLICY.includes("script-src 'none'"));
  t.true(SESSION_WIDGET_DOWNLOAD_POLICY.includes("connect-src 'none'"));
  t.false(/<meta\s+http-equiv="refresh"/iu.test(file));
  t.true(file.includes('data-http-equiv="refresh"'));
  t.true(file.indexOf("Content-Security-Policy") < file.indexOf("<p>x</p>"));
});
