import { createHash } from "node:crypto";

import type { ResearchArtifactRevision } from "@session/shared";
import { SESSION_WIDGET_DOWNLOAD_POLICY, sessionWidgetDownloadDocument } from "@session/shared";
import { widgetChangePrompt } from "@session/shared/lib/sessionWidgetActions";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import test from "ava";

import { setTrpcClient } from "../src/api/trpc.js";
import { ResearchMarkdown } from "../src/features/markdown/ResearchMarkdown.js";
import {
  researchTextProjection,
  rangeForTextOffsets,
} from "../src/features/research/selection/dom.js";
import { lineageLabel } from "../src/features/widgets/SessionWidgetMenu.js";
import { WidgetChangeContext, type WidgetAnswer } from "../src/features/widgets/context.js";
import { takeWidgetMessage, widgetFrameMessage } from "../src/features/widgets/widgetBridge.js";

import { createTrpcStub } from "./trpcStub.js";

test.afterEach.always(() => cleanup());

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const STATIC_URL = "http://artifacts.localhost:8787/w/static";
const RUN_URL = "http://artifacts.localhost:8787/w/run";

function revisionFor(
  html: string,
  overrides: Partial<ResearchArtifactRevision> = {},
): ResearchArtifactRevision {
  return {
    artifactId: "chart",
    title: "Growth chart",
    treeId: "tree-1",
    nodeId: "node-1",
    slot: "answer:0",
    revision: "b".repeat(64),
    contentHash: sha256(html),
    parentRevision: "a".repeat(64),
    html,
    createdAt: 1,
    unresolvedParent: false,
    ...overrides,
  };
}

function stubFor(html: string, options: { runUrl?: string | null } = {}) {
  const revision = revisionFor(html);
  const parent = revisionFor(html, {
    revision: "a".repeat(64),
    parentRevision: null,
    html: "<p>v1</p>",
  });
  let state = { enabled: false, value: null as unknown };
  const stub = createTrpcStub({
    "artifacts.prepareWidget": {
      staticUrl: STATIC_URL,
      runUrl: options.runUrl === undefined ? RUN_URL : options.runUrl,
      expiresAt: Date.now() + 60 * 60_000,
    },
    "artifacts.register": revision,
    "artifacts.history": { revisions: [parent, revision], unresolved: 1 },
    "artifacts.getState": () => state,
    "artifacts.updateState": (input: { action: string; value?: unknown }) => {
      if (input.action === "enable") state = { enabled: true, value: null };
      if (input.action === "disable") state = { enabled: false, value: null };
      if (input.action === "reset") state = { ...state, value: null };
      if (input.action === "save") state = { ...state, value: input.value };
      if (input.action === "migrate") state = { ...state, value: { from: "parent" } };
      return state;
    },
  });
  setTrpcClient(stub.client);
  return { stub, revision };
}

const widgetMarkdown = (html: string, meta = 'id=chart title="Growth chart"') =>
  `Before.\n\n\`\`\`session-html ${meta}\n${html}\n\`\`\`\n\nAfter.`;

async function frameOf(container: HTMLElement): Promise<HTMLIFrameElement> {
  await waitFor(() => {
    if (!container.querySelector("iframe")) throw new Error("frame pending");
  });
  return container.querySelector("iframe")!;
}

test.serial(
  "the frame is sandboxed for scripts only and the source view keeps the projection",
  async (t) => {
    const html = "<p>Static chart</p>";
    const { stub } = stubFor(html);
    const { container } = render(
      <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
    );
    const frame = await frameOf(container);
    t.is(frame.getAttribute("sandbox"), "allow-scripts");
    t.is(frame.getAttribute("src"), STATIC_URL);
    t.is(frame.getAttribute("referrerpolicy"), "no-referrer");
    const projection = researchTextProjection(container);
    t.false(projection.includes("Growth chart"));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    t.truthy(screen.getByText(html));
    t.is(container.querySelector("iframe"), frame);
    t.is(researchTextProjection(container), projection);
    const start = projection.indexOf("After.");
    t.is(rangeForTextOffsets(container, start, start + 6)?.toString(), "After.");
    // The client names the answer and the block; the server resolves the HTML.
    t.deepEqual(stub.calls.find((call) => call.path === "artifacts.prepareWidget")?.input, {
      nodeId: "node-1",
      sha256: sha256(html),
    });
    t.deepEqual(stub.calls.find((call) => call.path === "artifacts.register")?.input, {
      nodeId: "node-1",
      slot: "answer:9",
      html,
      meta: 'id=chart title="Growth chart"',
    });
    await waitFor(() => screen.getByText("Growth chart"));
    // A widget without scripts has no Run button and no status.
    t.is(screen.queryByRole("button", { name: "Run the widget's scripts" }), null);
    t.is(container.querySelector(".session-widget-status"), null);
  },
);

test.serial("Run scripts loads the run page; the status says Running", async (t) => {
  const html = "<p>Count</p><script>count()</script>";
  stubFor(html);
  const { container } = render(
    <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
  );
  await frameOf(container);
  fireEvent.click(await screen.findByRole("button", { name: "Run the widget's scripts" }));
  await waitFor(() => {
    if (container.querySelector("iframe")?.getAttribute("src") !== RUN_URL) throw new Error("run");
  });
  t.is(container.querySelector("iframe")?.getAttribute("sandbox"), "allow-scripts");
  t.is(container.querySelector(".session-widget-status")?.textContent, "Running");
  t.truthy(screen.getByRole("button", { name: "Reload widget" }));
  t.is(screen.queryByRole("button", { name: "Run the widget's scripts" }), null);
});

test.serial("without a run page the header says Scripts off", async (t) => {
  const html = "<p>Off</p><script>off()</script>";
  stubFor(html, { runUrl: null });
  const { container } = render(
    <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
  );
  await frameOf(container);
  await waitFor(() => {
    if (!container.querySelector(".session-widget-status")) throw new Error("status");
  });
  const status = container.querySelector(".session-widget-status")!;
  t.is(status.textContent, "Scripts off");
  t.regex(status.getAttribute("title") ?? "", /Widget scripts are off/u);
  t.is(screen.queryByRole("button", { name: "Run the widget's scripts" }), null);
});

test.serial("the menu lists actions, revisions and saved inputs", async (t) => {
  const html = "<p>Menu</p><script>menu()</script>";
  const { stub } = stubFor(html);
  const { container } = render(
    <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
  );
  await frameOf(container);
  await waitFor(() => screen.getByText("Growth chart"));
  fireEvent.click(screen.getByRole("button", { name: "Widget actions" }));
  await screen.findByRole("menu");
  for (const name of ["Copy HTML", "Download HTML", "Open expanded view"])
    t.truthy(screen.getByRole("menuitem", { name }), name);
  await waitFor(() => screen.getByText("bbbbbbbb"));
  t.truthy(screen.getByText("aaaaaaaa"));
  t.truthy(screen.getByText(`from ${"a".repeat(8)}`));
  t.truthy(screen.getByText("original"));
  t.truthy(screen.getByText(/1 source revision\(s\) could not be stored/u));
  const current = screen.getByText("bbbbbbbb").closest('[role="menuitem"]')!;
  t.is(current.getAttribute("aria-current"), "true");
  t.truthy(current.querySelector("svg"), "a check marks the current revision");
  t.truthy(stub.calls.find((call) => call.path === "artifacts.history"));

  const remember = await screen.findByRole("menuitemcheckbox", { name: "Remember inputs" });
  await waitFor(() => {
    if (remember.hasAttribute("data-disabled")) throw new Error("state loading");
  });
  t.is(remember.getAttribute("aria-checked"), "false");
  fireEvent.click(remember);
  await waitFor(() => screen.getByRole("menuitem", { name: "Reset inputs" }));
  t.like(stub.calls.find((call) => call.path === "artifacts.updateState")?.input, {
    action: "enable",
    reference: { treeId: "tree-1", artifactId: "chart", revision: "b".repeat(64) },
  });
  const copy = screen.getByRole("menuitem", { name: `Copy inputs from ${"a".repeat(8)}` });
  fireEvent.click(copy);
  await waitFor(() => {
    if (!stub.calls.some((call) => (call.input as { action?: string }).action === "migrate"))
      throw new Error("migrate");
  });
  t.pass();
});

test.serial(
  "a revision row previews that revision's static page in the expanded view",
  async (t) => {
    const html = "<p>Expanded</p><script>expanded()</script>";
    const { stub } = stubFor(html);
    const { container } = render(
      <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
    );
    await frameOf(container);
    await waitFor(() => screen.getByText("Growth chart"));
    fireEvent.click(screen.getByRole("button", { name: "Widget actions" }));
    fireEvent.click(await screen.findByText("aaaaaaaa"));
    const dialog = await screen.findByRole("dialog");
    const frame = await waitFor(() => {
      const element = dialog.querySelector("iframe");
      if (!element) throw new Error("expanded frame pending");
      return element;
    });
    t.is(frame.getAttribute("sandbox"), "allow-scripts");
    t.is(frame.getAttribute("title"), "Expanded answer widget");
    t.is(frame.getAttribute("src"), STATIC_URL);
    t.deepEqual(
      stub.calls.filter((call) => call.path === "artifacts.prepareWidget").at(-1)?.input,
      {
        treeId: "tree-1",
        artifactId: "chart",
        revision: "a".repeat(64),
      },
    );
  },
);

test.serial("Ask for changes passes the answer and the revision to the thread", async (t) => {
  const html = "<p>Static chart</p>";
  stubFor(html);
  const asked: { answer: WidgetAnswer; html: string }[] = [];
  const { container } = render(
    <WidgetChangeContext.Provider
      value={{ ask: (answer, source) => asked.push({ answer, html: source }) }}
    >
      <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />
    </WidgetChangeContext.Provider>,
  );
  await frameOf(container);
  const button = screen.getByRole("button", { name: "Ask for widget changes" });
  await waitFor(() => {
    if ((button as HTMLButtonElement).disabled) throw new Error("revision pending");
  });
  fireEvent.click(button);
  t.is(asked.length, 1);
  t.is(asked[0]!.html, html);
  t.is(asked[0]!.answer.nodeId, "node-1");
  t.is(asked[0]!.answer.artifact?.artifactId, "chart");
  const prompt = widgetChangePrompt(asked[0]!.answer, asked[0]!.html);
  t.true(prompt.includes(`parent="${"b".repeat(64)}"`));
  t.true(prompt.includes("Before."));
});

test.serial(
  "frame messages are accepted only from the frame, with a null origin, in shape and within budget",
  async (t) => {
    const html = "<p>Static chart</p>";
    stubFor(html);
    const { container } = render(
      <ResearchMarkdown widgetNodeId="node-1" markdown={widgetMarkdown(html)} />,
    );
    const frame = await frameOf(container);
    const own = frame.contentWindow!;
    const send = (data: unknown, origin = "null", source: Window | null = own) =>
      act(() => {
        window.dispatchEvent(new window.MessageEvent("message", { data, origin, source }));
      });
    send({ type: "session-widget-height", height: 320 });
    t.is(frame.style.height, "320px");
    send({ type: "session-widget-height", height: 99_999 });
    t.is(frame.style.height, "900px", "capped at the maximum");
    send({ type: "session-widget-height", height: 400 }, "http://localhost");
    send({ type: "session-widget-height", height: 400 }, "null", window);
    send({ type: "session-widget-height", height: "400" });
    t.is(frame.style.height, "900px", "other origins, other windows and bad shapes are ignored");

    t.is(widgetFrameMessage({ source: own, origin: "null", data: { type: "nope" } }, own), null);
    t.deepEqual(
      widgetFrameMessage(
        { source: own, origin: "null", data: { type: "session-widget-height", height: 10 } },
        own,
      ),
      { type: "height", height: 48 },
    );
    t.is(widgetFrameMessage({ source: own, origin: "null", data: {} }, null), null);
    const flood = {};
    let allowed = 0;
    for (let index = 0; index < 500; index += 1) if (takeWidgetMessage(flood, 0)) allowed += 1;
    t.is(allowed, 80, "a frame's burst is bounded");
    t.true(takeWidgetMessage(flood, 1000), "the budget refills");
  },
);

test.serial("ordinary Markdown and incomplete fences never prepare a widget", (t) => {
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

test("revision rows describe their lineage as the desktop does", (t) => {
  const html = "<p>x</p>";
  t.is(lineageLabel(revisionFor(html, { parentRevision: null })), "original");
  t.is(lineageLabel(revisionFor(html)), `from ${"a".repeat(8)}`);
  t.is(
    lineageLabel(revisionFor(html, { unresolvedParent: true })),
    "original (declared parent not found)",
  );
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
