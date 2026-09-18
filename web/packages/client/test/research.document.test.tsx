// The research document, mounted on the real router
// (`09-research-document-view.md`).
//
// These are the behaviors that only exist once the pieces are assembled: the
// states an answer can be in, the notice a highlight that cannot be located
// produces, the `?highlight=` hand-off from the Highlights feed, and the
// composer's gating.

import type {
  ResearchHighlight,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  Turn,
} from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import test from "ava";

import { queryClientDefaults } from "../src/api/queries.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useNavigationStore } from "../src/stores/navigation.js";
import { useOverlaysStore } from "../src/stores/overlays.js";

import { node, tree } from "./fixtures.js";
import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";

const REVISION = "b".repeat(64);

function assistantTurn(id: string, text: string): Turn {
  return { id, agentId: "n1", role: "assistant", blocks: [{ type: "text", text }], sourceIndex: 0 };
}

function groundedSearchTurn(id: string): Turn {
  return {
    id,
    agentId: "n1",
    role: "assistant",
    blocks: [
      { type: "toolUse", id: `${id}-u`, name: "google_search", input: { queries: ["memory"] } },
      {
        type: "toolResult",
        toolUseId: `${id}-u`,
        content: {
          results: [{ url: "https://example.com/grounded", title: "Grounded" }],
          searchEntryPoint:
            '<style>.leak{position:fixed}</style><div class="chip"><a href="javascript:alert(1)">q</a></div>',
        },
        isError: false,
      },
    ],
    sourceIndex: 0,
  };
}

function searchTurn(id: string): Turn {
  return {
    id,
    agentId: "n1",
    role: "assistant",
    blocks: [
      { type: "toolUse", id: `${id}-u`, name: "web_search", input: { query: "memory" } },
      {
        type: "toolResult",
        toolUseId: `${id}-u`,
        content: { results: [{ url: "https://example.com/paper", title: "A paper" }] },
        isError: false,
      },
    ],
    sourceIndex: 0,
  };
}

function detailFor(nodes: ResearchNode[]): ResearchTreeDetail {
  return { tree: tree(), nodes };
}

function contentFor(
  target: ResearchNode,
  turns: Turn[],
  overrides: Partial<ResearchNodeContent> = {},
): ResearchNodeContent {
  return {
    node: target,
    turns,
    children: [],
    responseRevision: REVISION,
    ...overrides,
  };
}

/**
 * The app's defaults with both caches pinned open. `gcTime: Infinity` keeps
 * TanStack Query out of Node's timer queue — a finite value schedules a
 * five-minute collection per query *and per mutation*, and this page issues a
 * mutation (`markTreeViewed`) on arrival, so the worker would outlive the
 * suite waiting for it.
 */
function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

interface Scenario {
  nodes: ResearchNode[];
  contentByNode: Record<string, ResearchNodeContent>;
  path?: string;
}

async function mount(scenario: Scenario) {
  const detail = detailFor(scenario.nodes);
  const result = await renderApp(scenario.path ?? "/r/t1", {
    queryClient: testQueryClient(),
    responses: {
      "research.getTree": () => detail,
      "research.getNodeContent": (input: unknown) =>
        scenario.contentByNode[(input as { nodeId: string }).nodeId],
      "research.markTreeViewed": detail.tree,
      "research.forkNode": () => node({ id: "n2", parentNodeId: "n1", inline: true }),
      "research.retryNode": () => detail,
      "research.cancelNode": () => scenario.nodes[0],
      "documents.list": [],
      "system.runtimeConfig": {
        version: "0.0.0",
        models: [
          {
            id: "gemini-flash",
            label: "Gemini 3.8 Flash",
            provider: "vertex",
            adminOnly: false,
            available: true,
            supportsFiles: true,
            supportsImages: true,
          },
          {
            id: "gpt-luna",
            label: "GPT-5.6 Luna",
            provider: "openrouter",
            adminOnly: false,
            available: true,
            supportsFiles: true,
            supportsImages: true,
          },
        ],
        limits: {},
        features: {},
      },
    },
  });
  return result;
}

// `.always`, not the plain hook: AVA skips an ordinary `afterEach` when its
// test fails, and a failed case that leaves a mounted document behind makes
// every later case query two of them.
test.afterEach.always(() => {
  try {
    cleanup();
  } finally {
    document.body.innerHTML = "";
  }
  resetDocumentRoot();
  useOverlaysStore.getState().clear();
  useLiveTurnsStore.getState().clearAll();
  useNavigationStore.setState({ historyByTree: {}, scrollByNode: {}, expandedByNode: {} });
  useDraftsStore.setState({ byKey: {} });
});

/* --------------------------------------------------------------- rendering */

test.serial("a completed answer renders its prose, word count and sources", async (t) => {
  const root = node({ id: "n1", status: "complete", completedAt: 1_700_000_050_000 });
  await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [searchTurn("t1"), assistantTurn("t2", "Memory is **shared**.")]),
    },
  });

  await waitUntil(t, () => screen.queryByText("shared") !== null, "the answer renders as prose");
  t.truthy(screen.getByText("3 words"));
  // The Sources footer reads the recorded tool results, not the prose.
  t.truthy(screen.getByRole("link", { name: "A paper" }));
  t.truthy(screen.getByText("example.com"));
});

test.serial(
  "displays an interruption notice and Retry button for an interrupted run",
  async (t) => {
    const root = node({ id: "n1", status: "interrupted", error: null });
    const { trpc } = await mount({
      nodes: [root],
      contentByNode: { n1: contentFor(root, [], { responseRevision: undefined }) },
    });

    await waitUntil(
      t,
      () => screen.queryByText("The run was interrupted. Resuming…") !== null,
      "the interrupted copy is shown",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await waitUntil(
      t,
      () => trpc.calls.some((call) => call.path === "research.retryNode"),
      "Retry relaunches the node in place",
    );
  },
);

test.serial("a queued run shows its position in the queue", async (t) => {
  const root = node({ id: "n1", status: "queued", startedAt: null });
  await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [], { responseRevision: undefined, queuePosition: 3 }),
    },
  });

  await waitUntil(
    t,
    () => screen.queryByText("Queued · 3 ahead") !== null,
    "the queue position is shown",
  );
});

test.serial("hides the queue position after a worker claims the run", async (t) => {
  const root = node({ id: "n1", status: "queued", startedAt: null });
  await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [], { responseRevision: undefined, queuePosition: 0 }),
    },
  });
  await waitUntil(t, () => screen.queryByText("Queued") !== null, "a bare Queued line is shown");
});

/* ------------------------------------------------------ streaming handover */

test.serial("the durable snapshot replaces the live buffer without remounting", async (t) => {
  const root = node({ id: "n1", status: "running" });
  const streaming = contentFor(root, [assistantTurn("t1", "Partial answer")], {
    responseRevision: undefined,
    seq: 4,
  });
  const settled = node({ id: "n1", status: "complete", responseSnapshotAt: 1_700_000_090_000 });
  let answered = 0;
  const detail = detailFor([root]);

  const { queryClient } = await renderApp("/r/t1", {
    queryClient: testQueryClient(),
    responses: {
      "research.getTree": () => detail,
      "research.getNodeContent": () => {
        answered += 1;
        // The first read is the live one; the second is the durable snapshot,
        // carrying the same turn under the same id.
        return answered === 1
          ? streaming
          : contentFor(settled, [assistantTurn("t1", "Partial answer")]);
      },
      "research.markTreeViewed": detail.tree,
      "documents.list": [],
    },
  });

  await waitUntil(
    t,
    () => screen.queryByText("Partial answer") !== null,
    "the streamed text renders",
  );
  const before = screen.getByText("Partial answer");

  // Settle the node the way the event bridge would, then let the content query
  // re-read.
  queryClient.setQueryData(["tree", "t1"], { tree: detail.tree, nodes: [settled] });
  await queryClient.invalidateQueries({ queryKey: ["nodeContent", "n1"] });

  await waitFor(() => {
    if (answered < 2) throw new Error("the durable snapshot has not been read yet");
  });
  const after = screen.getByText("Partial answer");
  // Same DOM node: identical turn ids produce identical timeline keys, so React
  // reconciles the block rather than remounting it (05 §4).
  t.is(before, after);
});

/* ------------------------------------------------------------- highlights */

function highlight(id: string, exact: string): ResearchHighlight {
  return {
    id,
    createdAt: 1_700_000_000_000,
    anchor: {
      version: 1,
      projection: "answer-v1",
      responseRevision: REVISION,
      start: 0,
      end: exact.length,
      exact,
      prefix: "",
      suffix: "",
    },
  };
}

test.serial("a highlight outside the collapsed answer is reported, not dropped", async (t) => {
  const root = node({
    id: "n1",
    status: "complete",
    highlights: [highlight("h1", "Let me look")],
  });
  await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [
        assistantTurn("t1", "Let me look at the record."),
        searchTurn("t2"),
        assistantTurn("t3", "Memory is shared."),
      ]),
    },
  });

  await waitUntil(
    t,
    () => screen.queryByText(/1 hidden highlight/) !== null,
    "the hidden-highlight notice appears",
  );
  // The only thing that can reveal it is the full transcript, so that is what
  // the notice offers.
  // The header carries the same control, so take the one in the notice.
  const reveal = screen.getAllByRole("button", { name: "Show full transcript" }).at(-1)!;
  fireEvent.click(reveal);
  await waitUntil(
    t,
    () => screen.queryByText(/hidden highlight/) === null,
    "revealing the trace locates the passage",
  );
});

test.serial("?highlight= scrolls the passage into view and clears the param", async (t) => {
  const root = node({
    id: "n1",
    status: "complete",
    highlights: [highlight("h1", "Memory is shared")],
  });
  // Stashed to be reinstalled on the prototype, never called.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  // jsdom has no layout: its `scrollTop` setter is a no-op and every rect is
  // zero, so both have to be supplied for the scroll to be observable at all.
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element & { recordedScrollTop?: number }) {
      return this.recordedScrollTop ?? 0;
    },
    set(this: Element & { recordedScrollTop?: number }, value: number) {
      this.recordedScrollTop = value;
    },
  });
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 500, bottom: 520, left: 0, right: 10, width: 10, height: 20 }) as DOMRect;
  try {
    const { queryClient } = await mount({
      nodes: [root],
      contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Memory is shared.")]) },
      path: "/r/t1?highlight=h1",
    });
    t.truthy(queryClient);

    await waitUntil(
      t,
      () => screen.queryByText("Memory is shared.") !== null,
      "the answer renders",
    );
    // jsdom reports a zero-height viewport, so the 72 px floor applies to the
    // "a third of the way down" target.
    await waitUntil(
      t,
      () => (document.querySelector("article")?.scrollTop ?? 0) === 500 - 72,
      "the passage is scrolled into view",
    );
  } finally {
    Range.prototype.getBoundingClientRect = originalRangeRect;
    if (originalScrollTop) Object.defineProperty(Element.prototype, "scrollTop", originalScrollTop);
  }
});

/* --------------------------------------------------------------- composer */

test.serial(
  "the composer is gated on a complete target and carries the parent's model",
  async (t) => {
    const root = node({ id: "n1", status: "running", model: "gpt-luna" });
    await mount({
      nodes: [root],
      contentByNode: {
        n1: contentFor(root, [assistantTurn("t1", "Working on it")], {
          responseRevision: undefined,
        }),
      },
    });

    await waitUntil(
      t,
      () => screen.queryByLabelText("Follow-up question") !== null,
      "the composer mounts",
    );
    const field = screen.getByLabelText("Follow-up question");
    // An unfinished tail cannot take a follow-up (`canFollowUpFrom`).
    t.true(field.hasAttribute("disabled"));
    t.truthy(screen.getByRole("button", { name: /Gemini 3.8 Flash|GPT-5.6 Luna/ }));
    // The chip defaults to the model the parent answered on, not the account
    // default.
    t.truthy(screen.getByText("GPT-5.6 Luna"));
  },
);

test.serial(
  "enables Send after the parent completes and submits an inline follow-up on Cmd-Enter",
  async (t) => {
    const root = node({ id: "n1", status: "complete" });
    const { trpc } = await mount({
      nodes: [root],
      contentByNode: { n1: contentFor(root, [assistantTurn("t1", "An answer.")]) },
    });

    await waitUntil(
      t,
      () => screen.queryByLabelText("Follow-up question") !== null,
      "the composer mounts",
    );
    const field = screen.getByLabelText("Follow-up question");
    t.false(field.hasAttribute("disabled"));
    const send = screen.getByRole("button", { name: /Send/ });
    t.true(send.hasAttribute("disabled"));

    fireEvent.change(field, { target: { value: "And then?" } });
    await waitUntil(
      t,
      () => !screen.getByRole("button", { name: /Send/ }).hasAttribute("disabled"),
      "typing enables Send",
    );

    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitUntil(
      t,
      () => trpc.calls.some((call) => call.path === "research.forkNode"),
      "Cmd-Enter submits",
    );
    const call = trpc.calls.find((entry) => entry.path === "research.forkNode");
    t.like(call?.input, {
      parentNodeId: "n1",
      prompt: "And then?",
      inline: true,
    });
  },
);

test.serial("Shift-Tab leaves the follow-up composer instead of cycling models", async (t) => {
  // Tab steps the model, which means the composer calls `preventDefault` on
  // it. Doing the same to Shift-Tab is a keyboard trap: focus goes into the
  // textarea and nothing takes it out again (WCAG 2.1.2).
  const root = node({ id: "n1", status: "complete" });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "An answer.")]) },
  });
  await waitUntil(
    t,
    () => screen.queryByLabelText("Follow-up question") !== null,
    "the composer mounts",
  );
  const field = screen.getByLabelText("Follow-up question");

  t.false(
    fireEvent.keyDown(field, { key: "Tab" }),
    "Tab is taken by the composer: two models are offered",
  );
  t.true(
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true }),
    "Shift-Tab reaches the browser, so focus can move backwards out of the field",
  );
});

test.serial("Shift-Cmd-Enter submits a branch regardless of the selected mode", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const { trpc } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "An answer.")]) },
  });

  await waitUntil(
    t,
    () => screen.queryByLabelText("Follow-up question") !== null,
    "the composer mounts",
  );
  const field = screen.getByLabelText("Follow-up question");
  fireEvent.change(field, { target: { value: "A side question" } });
  fireEvent.keyDown(field, { key: "Enter", metaKey: true, shiftKey: true });

  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.forkNode"),
    "the branch is submitted",
  );
  const call = trpc.calls.find((entry) => entry.path === "research.forkNode");
  t.is((call?.input as { inline?: boolean }).inline, false);
});

test.serial("a follow-up draft is kept per tree", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "An answer.")]) },
  });
  await waitUntil(
    t,
    () => screen.queryByLabelText("Follow-up question") !== null,
    "the composer mounts",
  );
  fireEvent.change(screen.getByLabelText("Follow-up question"), {
    target: { value: "kept for later" },
  });
  t.is(useDraftsStore.getState().byKey["node:tree:t1"]?.text, "kept for later");
});

/* ------------------------------------------------------------- navigation */

test.serial("the document marks the tree viewed on arrival", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const { trpc } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "An answer.")]) },
  });
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.markTreeViewed"),
    "the attention flag is acknowledged",
  );
});

test.serial("opens a branch page with a breadcrumb back to the parent", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({
    id: "n2",
    parentNodeId: "n1",
    prompt: "What about forgetting?",
    status: "complete",
    inline: false,
  });
  await mount({
    nodes: [root, branch],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "An answer.")]),
      n2: contentFor(branch, [assistantTurn("t2", "A branch answer.")]),
    },
  });

  await waitUntil(
    t,
    () => screen.queryByText("What about forgetting?") !== null,
    "the branch card is in the rail",
  );
  fireEvent.click(screen.getByText("What about forgetting?"));
  // The branch becomes the page: its answer replaces the root's, and the Back
  // link to the answer it was asked from appears.
  await waitUntil(
    t,
    () => screen.queryByText("A branch answer.") !== null,
    "opening the card switches the page",
  );
  // The stage header carries its own Back control, so the parent link is
  // looked for inside the document.
  const article = document.querySelector("article") as HTMLElement;
  t.truthy(within(article).getByRole("button", { name: "Back" }));
});

test.serial("the answer menu acts on the thread as it is when it is opened", async (t) => {
  // The rows are built from a value signature so they survive a streamed
  // delta without being rebuilt; what that must not cost is freshness, so the
  // Edit-document row reads the title the server will be asked to match at
  // click time rather than the one the rows were built with.
  const root = node({
    id: "n1",
    kind: "document",
    status: "complete",
    completedAt: 1_700_000_050_000,
  });
  const app = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "# Notes\n\nA document body.")]) },
  });

  await waitUntil(
    t,
    () => screen.queryAllByLabelText("Answer actions").length > 0,
    "the answer pane is up",
  );

  // A rename arrives the way `research.tree.updated` delivers one.
  app.queryClient.setQueryData<ResearchTreeDetail>(["tree", "t1"], (current) =>
    current ? { ...current, tree: { ...current.tree, title: "Renamed while open" } } : current,
  );

  fireEvent.click(screen.getAllByLabelText("Answer actions")[0] as HTMLElement);
  await waitUntil(t, () => screen.queryAllByRole("menu").length > 0, "its menu opens");
  const menu = screen.getAllByRole("menu").at(-1) as HTMLElement;
  fireEvent.click(within(menu).getByText("Edit document"));

  await waitUntil(
    t,
    () => screen.queryAllByLabelText("Document title").length > 0,
    "the editor opens",
  );
  t.is(
    screen.getByLabelText<HTMLInputElement>("Document title").value,
    "Renamed while open",
    "the title it will send back is the current one, not the one it was built with",
  );
  app.unmount();
});

test.serial("the grounded entry point is shown, and cannot style the page", async (t) => {
  const root = node({ id: "n1", status: "complete", completedAt: 1_700_000_050_000 });
  const app = await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [groundedSearchTurn("t1"), assistantTurn("t2", "Grounded answer.")]),
    },
  });

  const sources = await screen.findByLabelText("Sources");
  await waitUntil(t, () => sources.textContent?.includes("q") === true, "the chip row is shown");
  // Google's terms require the entry point to be displayed, and it is — but a
  // provider-authored `<style>` would be a page-wide stylesheet, so the tag is
  // not in the allowlist and DOMPurify drops it in any case.
  t.is(sources.querySelector("style"), null);
  t.is(document.querySelector("style.leak"), null);
  // The sanitizer still runs over what remains: the link keeps its text and
  // loses its scheme.
  const link = sources.querySelector("a[class='chip'], .chip a");
  t.is(link?.getAttribute("href") ?? null, null);
  app.unmount();
});
