// The thread page, mounted on the real router (`09-research-document-view.md`).
//
// What only exists once the pieces are assembled: the paired columns of the
// shared strip, the selection in `?sel=`, the branches column and its margin
// markers, the server's follow-up queue in a messages column, the ask box,
// note columns and the editor, the answer menu's Rerun.

import type {
  ResearchFollowupQueueItem,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  Turn,
} from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import test from "ava";

import { queryClientDefaults } from "../src/api/queries.js";
import { resetThreadNavigationForTests } from "../src/features/thread/persistence.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useOverlaysStore } from "../src/stores/overlays.js";

import { node, tree } from "./fixtures.js";
import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";

const REVISION = "b".repeat(64);

function assistantTurn(id: string, text: string, agentId = "n1"): Turn {
  return { id, agentId, role: "assistant", blocks: [{ type: "text", text }], sourceIndex: 0 };
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

function contentFor(
  target: ResearchNode,
  turns: Turn[],
  overrides: Partial<ResearchNodeContent> = {},
): ResearchNodeContent {
  return { node: target, turns, responseRevision: REVISION, ...overrides };
}

function anchorFor(exact: string, start = 0): ResearchHighlightAnchor {
  return {
    version: 1,
    projection: "answer-v1",
    responseRevision: REVISION,
    start,
    end: start + exact.length,
    exact,
    prefix: "",
    suffix: "",
  };
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

const MODELS = [
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
];

interface Scenario {
  nodes: ResearchNode[];
  contentByNode: Record<string, ResearchNodeContent>;
  queues?: Record<string, ResearchFollowupQueueItem[]>;
  path?: string;
  responses?: Record<string, unknown>;
}

async function mount(scenario: Scenario) {
  const detail: ResearchTreeDetail = {
    tree: tree(),
    nodes: scenario.nodes,
    ...(scenario.queues ? { queues: scenario.queues } : {}),
  };
  return renderApp(scenario.path ?? "/r/t1", {
    queryClient: testQueryClient(),
    responses: {
      "research.getTree": () => detail,
      "research.getNodeContent": (input: unknown) =>
        scenario.contentByNode[(input as { nodeId: string }).nodeId],
      "research.markTreeViewed": detail.tree,
      "research.cancelNode": () => scenario.nodes[0],
      "system.runtimeConfig": { version: "0.0.0", models: MODELS, limits: {}, features: {} },
      ...scenario.responses,
    },
  });
}

/** The URL's `?sel=`, decoded. */
function selection(router: { state: { location: { search: unknown } } }): string[] {
  const sel = (router.state.location.search as { sel?: string }).sel;
  return sel ? sel.split(",") : [];
}

test.afterEach.always(() => {
  try {
    cleanup();
  } finally {
    document.body.innerHTML = "";
  }
  resetDocumentRoot();
  useOverlaysStore.getState().clear();
  useLiveTurnsStore.getState().clearAll();
  useDraftsStore.setState({ byKey: {} });
  localStorage.clear();
  sessionStorage.clear();
  resetThreadNavigationForTests();
});

/* ------------------------------------------------------------ the columns */

test.serial("a thread opens as a messages column beside its answer column", async (t) => {
  const root = node({ id: "n1", status: "complete", completedAt: 1_700_000_050_000 });
  const { router } = await mount({
    nodes: [root],
    contentByNode: {
      n1: contentFor(root, [searchTurn("t1"), assistantTurn("t2", "Memory is **shared**.")]),
    },
  });
  await waitUntil(t, () => screen.queryByText("shared") !== null, "the answer renders");
  const messages = screen.getByRole("region", { name: "Messages: Collective memory" });
  t.truthy(within(messages).getByText("What is collective memory?"));
  t.truthy(screen.getByRole("region", { name: /^Answer to: What is collective memory\?/ }));
  t.truthy(screen.getByRole("heading", { name: "Collective memory" }));
  // The Sources footer reads the recorded tool results.
  t.truthy(screen.getByRole("link", { name: "A paper" }));
  // Opening the thread records the selection it shows, in place.
  await waitUntil(t, () => selection(router).join() === "n1", "the selection is in the URL");
});

test.serial("selecting a message shows its answer and pushes a history entry", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const second = node({
    id: "n2",
    parentNodeId: "n1",
    inline: true,
    status: "complete",
    prompt: "And how is it kept?",
  });
  const { router } = await mount({
    nodes: [root, second],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "First answer.")]),
      n2: contentFor(second, [assistantTurn("t2", "Second answer.", "n2")]),
    },
  });
  // A chain opens on its last message.
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "the last answer shows");
  const row = screen.getByRole("button", { name: "What is collective memory?" });
  fireEvent.click(row);
  await waitUntil(t, () => screen.queryByText("First answer.") !== null, "the first answer shows");
  t.is(screen.queryByText("Second answer."), null);
  t.deepEqual(selection(router), ["n1"]);
  t.is(row.getAttribute("aria-current"), "true");
  router.history.back();
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "Back restores it");
});

test.serial("a branch from the whole answer opens in the branches column", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({
    id: "b1",
    parentNodeId: "n1",
    status: "complete",
    prompt: "Why does it fade?",
  });
  const { router } = await mount({
    nodes: [root, branch],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "Root answer.")]),
      b1: contentFor(branch, [assistantTurn("t2", "Branch answer.", "b1")]),
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the root answer shows");
  // The branches column lists the branch without opening it.
  const branches = screen.getByRole("region", { name: "Branches" });
  t.truthy(within(branches).getByRole("heading", { name: /^Branches ?· 1$/ }));
  t.is(screen.queryByText("Branch answer."), null);
  // The whole-answer marker sits in the answer's foot; it opens the branch.
  const marker = await waitFor(() =>
    screen.getByRole("button", { name: /^1 branch from the whole answer\. Opens/ }),
  );
  fireEvent.click(marker);
  await waitUntil(t, () => screen.queryByText("Branch answer.") !== null, "the branch opens");
  t.deepEqual(selection(router), ["n1", "b1"]);
  // The row's indicator reads as open, and clears the column when pressed.
  const indicator = screen.getByRole("button", {
    name: /1 branch from this answer\. One is selected\./,
  });
  fireEvent.click(indicator);
  await waitUntil(t, () => screen.queryByText("Branch answer.") === null, "the branch closes");
  t.deepEqual(selection(router), ["n1"]);
});

test.serial("a queued follow-up is listed under the chain with Cancel", async (t) => {
  const root = node({ id: "n1", status: "running" });
  const item: ResearchFollowupQueueItem = {
    id: "q1",
    treeId: "t1",
    headNodeId: "n1",
    authorId: "u1",
    message: { text: "A question to cancel" },
    agent: { adapter: "gemini", model: "gemini-flash", effort: null },
    position: 0,
    createdAt: 1_700_000_000_000,
    failedReason: null,
  };
  const { trpc } = await mount({
    nodes: [root],
    queues: { n1: [item] },
    contentByNode: { n1: contentFor(root, [], { responseRevision: undefined, seq: 0 }) },
    responses: { "followups.cancel": [] },
  });
  await waitUntil(t, () => screen.queryByText("A question to cancel") !== null, "the item shows");
  const row = screen.getByText("A question to cancel").closest("li") as HTMLElement;
  t.truthy(within(row).getByText("Queued"));
  fireEvent.click(within(row).getByRole("button", { name: "Cancel this queued message" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "followups.cancel"),
    "Cancel removes it on the server",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "followups.cancel")?.input, { itemId: "q1" });
});

test.serial("the ask box sends a follow-up through the server's queue with ⌘↵", async (t) => {
  const root = node({ id: "n1", status: "running" });
  const { trpc } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [], { responseRevision: undefined, seq: 0 }) },
    responses: {
      "followups.ask": (input: { prompt: string }) => ({
        kind: "queued",
        item: {
          id: "q2",
          treeId: "t1",
          headNodeId: "n1",
          authorId: "u1",
          message: { text: input.prompt },
          agent: { adapter: "gemini", model: "gemini-flash", effort: null },
          position: 0,
          createdAt: 1_700_000_000_000,
          failedReason: null,
        },
      }),
    },
  });
  const field = await waitFor(() =>
    screen.getByRole("textbox", { name: "Follow-up in this conversation" }),
  );
  t.is(field.getAttribute("placeholder"), "Queue a follow-up");
  fireEvent.change(field, { target: { value: "And then?" } });
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true });
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "followups.ask"),
    "the follow-up is asked",
  );
  const input = trpc.calls.find((call) => call.path === "followups.ask")?.input as {
    headNodeId: string;
    prompt: string;
    model: string;
  };
  t.is(input.headNodeId, "n1");
  t.is(input.prompt, "And then?");
  t.is(input.model, "gemini-flash");
  await waitUntil(t, () => screen.queryByText("And then?") !== null, "the queued item is listed");
});

test.serial(
  "⌘J focuses the current level's ask box; its model menu lists the models",
  async (t) => {
    const root = node({ id: "n1", status: "complete" });
    await mount({
      nodes: [root],
      contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    });
    const field = await waitFor(() =>
      screen.getByRole("textbox", { name: "Follow-up in this conversation" }),
    );
    t.not(document.activeElement, field);
    act(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "j",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await waitUntil(t, () => document.activeElement === field, "the ask box takes focus");
    fireEvent.click(screen.getByTitle("Model for this follow-up"));
    const item = await waitFor(() => screen.getByRole("menuitem", { name: /Gemini/ }));
    t.truthy(item);
  },
);

test.serial("Edit question sends a fork that replaces the failed node", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const failed = node({
    id: "n2",
    parentNodeId: "n1",
    inline: true,
    status: "failed",
    error: "The provider refused.",
    prompt: "A failed question",
  });
  const { trpc } = await mount({
    nodes: [root, failed],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "Root answer.")]),
      n2: contentFor(failed, [], { responseRevision: undefined }),
    },
    responses: {
      "research.forkNode": () =>
        node({ id: "n3", parentNodeId: "n1", inline: true, status: "queued" }),
    },
  });
  const edit = await waitFor(() => screen.getByRole("button", { name: "Edit question" }));
  t.truthy(screen.getByText("The provider refused."));
  fireEvent.click(edit);
  const field = await waitFor(() =>
    screen.getByRole("textbox", { name: "Edit the failed question" }),
  );
  t.is((field as HTMLTextAreaElement).value, "A failed question");
  fireEvent.change(field, { target: { value: "A better question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.forkNode"),
    "the edited question is forked",
  );
  t.like(trpc.calls.find((call) => call.path === "research.forkNode")?.input, {
    parentNodeId: "n1",
    prompt: "A better question",
    inline: true,
    replacesNodeId: "n2",
  });
});

test.serial("Rerun asks before replacing a complete answer", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const detail: ResearchTreeDetail = { tree: tree(), nodes: [root] };
  const { trpc } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: { "research.rerunNode": () => detail },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer shows");
  fireEvent.click(screen.getAllByRole("button", { name: "Answer actions" })[0] as HTMLElement);
  fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Rerun" })));
  const dialog = await waitFor(() => screen.getByRole("dialog", { name: "Rerun" }));
  t.truthy(within(dialog).getByText("Rerun will replace the current answer. Continue?"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.rerunNode"),
    "the rerun is requested",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "research.rerunNode")?.input, {
    nodeId: "n1",
  });
});

test.serial("a recap is shown above the answer it was written for", async (t) => {
  const base = node({ id: "n1", status: "complete" });
  const root = {
    ...base,
    recap: { id: "r1", text: "Memory is shared.", responseRevision: REVISION, generatedAt: 1 },
  } as ResearchNode;
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
  });
  await waitUntil(
    t,
    () => screen.queryByText("Recap: Memory is shared.") !== null,
    "the recap shows",
  );
});

test.serial("a queued run shows its place in the queue", async (t) => {
  const root = node({ id: "n1", status: "queued", startedAt: null });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [], { responseRevision: undefined, queuePosition: 3 }) },
  });
  await waitUntil(t, () => screen.queryByText("Queued · 3 ahead") !== null, "the position shows");
});

test.serial("the durable snapshot replaces the live buffer without remounting", async (t) => {
  const root = node({ id: "n1", status: "running" });
  const streaming = contentFor(root, [assistantTurn("t1", "Partial answer")], {
    responseRevision: undefined,
    seq: 4,
  });
  const settled = node({ id: "n1", status: "complete", responseSnapshotAt: 1_700_000_090_000 });
  let answered = 0;
  const detail: ResearchTreeDetail = { tree: tree(), nodes: [root] };
  const { queryClient } = await renderApp("/r/t1", {
    queryClient: testQueryClient(),
    responses: {
      "research.getTree": () => detail,
      "research.getNodeContent": () => {
        answered += 1;
        return answered === 1
          ? streaming
          : contentFor(settled, [assistantTurn("t1", "Partial answer")]);
      },
      "research.markTreeViewed": detail.tree,
    },
  });
  await waitUntil(
    t,
    () => screen.queryByText("Partial answer") !== null,
    "the streamed text renders",
  );
  const before = screen.getByText("Partial answer");
  act(() => {
    queryClient.setQueryData(["tree", "t1"], { tree: detail.tree, nodes: [settled] });
  });
  await queryClient.invalidateQueries({ queryKey: ["nodeContent", "n1"] });
  await waitFor(() => {
    if (answered < 2) throw new Error("the durable snapshot has not been read yet");
  });
  t.is(screen.getByText("Partial answer"), before);
});

/* ------------------------------------------------------------ notes */

function post(overrides: Partial<ResearchNode> & { text?: string } = {}): ResearchNode {
  const { text = "A note about memory", ...rest } = overrides;
  return {
    id: "n1",
    treeId: "t1",
    groupId: "w1",
    parentNodeId: null,
    title: null,
    createdAt: 1_700_000_000_000,
    highlights: [],
    type: "post",
    format: "text",
    message: { text },
    followUpAgent: { adapter: "gemini", model: "gemini-flash", effort: null },
    ...rest,
  } as ResearchNode;
}

test.serial("a note opens as its note column and its follow-ups column", async (t) => {
  const note = post();
  const { trpc } = await mount({
    nodes: [note],
    contentByNode: {},
    responses: {
      "research.createPostFollowUp": () =>
        post({ id: "n2", parentNodeId: "n1", text: "A follow-up note" }),
    },
  });
  const column = await waitFor(() => screen.getByRole("region", { name: /^Note:/ }));
  t.truthy(within(column).getByText("A note about memory"));
  const followUps = screen.getByRole("region", { name: "Follow-ups" });
  t.truthy(within(followUps).getByText("No follow-ups yet."));
  const field = within(followUps).getByRole("textbox", { name: "Follow-up" });
  fireEvent.focus(field);
  fireEvent.click(
    await waitFor(() => within(followUps).getByRole("radio", { name: "Add a note" })),
  );
  t.is(field.getAttribute("placeholder"), "Add a note (not visible to agent)");
  fireEvent.change(field, { target: { value: "A follow-up note" } });
  fireEvent.click(within(followUps).getByRole("button", { name: "Add note" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.createPostFollowUp"),
    "the follow-up note is added",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "research.createPostFollowUp")?.input, {
    parentNodeId: "n1",
    body: "A follow-up note",
  });
});

test.serial("a double-click edits a note and a stale edit is refused", async (t) => {
  const note = post();
  const { trpc } = await mount({
    nodes: [note],
    contentByNode: {},
    responses: {
      "research.updatePost": () => {
        throw new Error("the note changed while you were editing; reopen the editor and try again");
      },
    },
  });
  const column = await waitFor(() => screen.getByRole("region", { name: /^Note:/ }));
  const body = within(column).getByText("A note about memory");
  fireEvent.doubleClick(body);
  const field = await waitFor(() => screen.getByRole("textbox", { name: "Note text" }));
  t.is((field as HTMLTextAreaElement).value, "A note about memory");
  fireEvent.change(field, { target: { value: "An edited note" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitUntil(
    t,
    () => screen.queryByText(/the note changed while you were editing/) !== null,
    "the refusal is shown in the editor",
  );
  t.like(trpc.calls.find((call) => call.path === "research.updatePost")?.input, {
    nodeId: "n1",
    text: "An edited note",
    expectedText: "A note about memory",
  });
  // The editor stays open with the text.
  t.is(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note text" }).value,
    "An edited note",
  );
});

test.serial("?edit= opens a note in the editor and leaves the URL", async (t) => {
  const note = post();
  const { router } = await mount({
    nodes: [note],
    contentByNode: {},
    path: "/r/t1?node=n1&edit=n1",
  });
  const field = await waitFor(() => screen.getByRole("textbox", { name: "Note text" }));
  t.is((field as HTMLTextAreaElement).value, "A note about memory");
  await waitUntil(
    t,
    () => (router.state.location.search as { edit?: string }).edit === undefined,
    "the parameter is removed",
  );
});

/* --------------------------------------------------------- a passage */

test.serial("a passage branch's source quotes the passage", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({
    id: "b1",
    parentNodeId: "n1",
    status: "complete",
    prompt: "Why?",
    queryAnchor: anchorFor("Root"),
  });
  await mount({
    nodes: [root, branch],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "Root answer.")]),
      b1: contentFor(branch, [assistantTurn("t2", "Because.", "b1")]),
    },
    path: "/r/t1?sel=n1,b1",
  });
  await waitUntil(t, () => screen.queryByText("Because.") !== null, "the branch is open");
  const branches = screen.getByRole("region", { name: "Branches" });
  t.truthy(within(branches).getByText("“Root”"));
  t.truthy(within(branches).getByRole("heading", { name: /^Branches ?· 1$/ }));
});
