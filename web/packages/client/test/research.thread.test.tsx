// The thread page, mounted on the real router (`09-research-document-view.md`).
//
// What only exists once the pieces are assembled: the paired columns of the
// shared strip, the selection in `?sel=`, the branches column and its margin
// markers, the server's follow-up queue in a messages column, the ask box,
// note columns and the editor, the answer menu's Rerun.

import type {
  ResearchFolderState,
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
import { historyChordTitles } from "../src/features/thread/ColumnChrome.js";
import { resetThreadNavigationForTests } from "../src/features/thread/persistence.js";
import { resetEditedDraftKeysForTests, useDraftsStore } from "../src/stores/drafts.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useOverlaysStore } from "../src/stores/overlays.js";

import { node, summary, tree } from "./fixtures.js";
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
  resetEditedDraftKeysForTests();
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

test.serial("a settled run without a completion time is measured up to now", async (t) => {
  const root = node({ id: "n1", status: "failed", startedAt: Date.now() - 65_000 });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Partial answer.")]) },
  });
  await waitUntil(t, () => screen.queryByText("Partial answer.") !== null, "the answer shows");
  fireEvent.click(screen.getAllByRole("button", { name: "Answer actions" })[0] as HTMLElement);
  const menu = await waitFor(() => screen.getByRole("menu", { name: "Answer actions" }));
  t.regex(menu.textContent ?? "", /Ran for 1m 0[5-9]s/);
  t.false((menu.textContent ?? "").includes("Ran for 0s"));
});

test.serial("Back and Forward name the browser's chords", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer shows");
  const titles = historyChordTitles();
  t.deepEqual(historyChordTitles(true), { back: "Back (⌘[)", forward: "Forward (⌘])" });
  t.is(screen.getByRole("button", { name: "Back" }).getAttribute("title"), titles.back);
  t.is(screen.getByRole("button", { name: "Forward" }).getAttribute("title"), titles.forward);
});

test.serial("while a thread loads, its header shows the title a list already has", async (t) => {
  const queryClient = testQueryClient();
  queryClient.setQueryData(
    ["trees", { workspaceId: "w1", includeArchived: true }],
    [summary({ id: "t1", title: "Collective memory" })],
  );
  await renderApp("/r/t1", {
    queryClient,
    responses: {
      // Never answers, so the placeholder stays.
      "research.getTree": () => new Promise(() => {}),
    },
  });
  await waitUntil(
    t,
    () => screen.queryByText("Loading research…") !== null,
    "the loading placeholder",
  );
  t.truthy(screen.getByRole("heading", { name: "Collective memory" }));
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

test.serial("the root's answer menu moves the thread to a folder", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const folders: ResearchFolderState = {
    folders: [{ id: "f1", name: "Papers", workspaceId: "w1" }],
    membership: {},
    collapsed: [],
    parents: {},
    collapsedGroups: [],
  };
  const { trpc } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: {
      "research.listTrees": [summary({ runningCount: 0, completedCount: 1 })],
      "folders.get": folders,
      "folders.set": (input: { state: ResearchFolderState }) => input.state,
      "research.listTrash": [],
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer shows");
  const openMenu = async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Answer actions" })[0] as HTMLElement);
    return waitFor(() => screen.getByRole("menu", { name: "Answer actions" }));
  };
  let menu = await openMenu();
  await waitUntil(
    t,
    () => within(menu).queryByRole("group", { name: "Move to" }) !== null,
    "Move to is listed once the workspace's threads load",
  );
  const group = within(menu).getByRole("group", { name: "Move to" });
  t.deepEqual(
    within(group)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim()),
    ["Unfiled", "Drafts", "Papers", "Archive"],
  );
  t.is(
    within(group).getByRole("menuitem", { name: "Unfiled" }).getAttribute("aria-checked"),
    "true",
  );
  t.truthy(within(menu).getByRole("menuitem", { name: "New folder…" }));
  fireEvent.click(within(group).getByRole("menuitem", { name: "Papers" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "folders.set"),
    "the membership is saved",
  );
  const saved = trpc.calls.find((call) => call.path === "folders.set")?.input as {
    workspaceId: string;
    state: ResearchFolderState;
  };
  t.is(saved.workspaceId, "w1");
  t.deepEqual(saved.state.membership, { t1: "f1" });
  menu = await openMenu();
  await waitUntil(
    t,
    () =>
      within(menu).queryByRole("menuitem", { name: "Papers" })?.getAttribute("aria-checked") ===
      "true",
    "the folder is now the current place",
  );
});

test.serial("the Home group is listed above the messages and opens its threads", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const folders: ResearchFolderState = {
    folders: [],
    membership: {},
    collapsed: [],
    parents: { t2: "t1" },
    collapsedGroups: ["t1"],
  };
  const { trpc, router } = await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: {
      "research.listTrees": [
        summary({ runningCount: 0, completedCount: 1 }),
        summary({ id: "t2", rootNodeId: "m1", title: "A child thread", runningCount: 0 }),
      ],
      "folders.get": folders,
      "folders.set": (input: { state: ResearchFolderState }) => input.state,
      "research.listTrash": [],
    },
  });
  const panel = await waitFor(() => screen.getByRole("navigation", { name: /In this group/ }));
  t.is(within(panel).getByRole("heading").textContent, "In this group · 1");
  fireEvent.click(within(panel).getByRole("button", { name: /A child thread/ }));
  await waitUntil(t, () => router.state.location.pathname === "/r/t2", "the child opens");
  // Opening a child from the panel expands its group in Home.
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "folders.set"),
    "the group is expanded",
  );
  const saved = trpc.calls.find((call) => call.path === "folders.set")?.input as {
    state: ResearchFolderState;
  };
  t.deepEqual(saved.state.collapsedGroups, []);
});

test.serial("a child thread links to its parent", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: {
      "research.listTrees": [
        summary({ id: "t0", rootNodeId: "p1", title: "The parent", runningCount: 0 }),
        summary({ runningCount: 0, completedCount: 1 }),
      ],
      "folders.get": {
        folders: [],
        membership: {},
        collapsed: [],
        parents: { t1: "t0" },
        collapsedGroups: [],
      },
      "research.listTrash": [],
    },
  });
  const panel = await waitFor(() => screen.getByRole("navigation", { name: "Parent thread" }));
  t.truthy(within(panel).getByRole("button", { name: "In “The parent”" }));
});

test.serial("a shared thread's menu has no Move to", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const detail: ResearchTreeDetail = {
    tree: tree({ role: "commenter", ownerId: "someone-else" }),
    nodes: [root],
  };
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: {
      "research.getTree": () => detail,
      "research.markTreeViewed": detail.tree,
      "research.listTrees": [
        summary({ runningCount: 0, role: "commenter", ownerId: "someone-else" }),
      ],
      "folders.get": {
        folders: [],
        membership: {},
        collapsed: [],
        parents: {},
        collapsedGroups: [],
      },
      "research.listTrash": [],
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer shows");
  fireEvent.click(screen.getAllByRole("button", { name: "Answer actions" })[0] as HTMLElement);
  const menu = await waitFor(() => screen.getByRole("menu", { name: "Answer actions" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  t.is(within(menu).queryByRole("group", { name: "Move to" }), null);
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

test.serial(
  "links out of the thread page keep the workspace and drop the thread's params",
  async (t) => {
    const root = node({ id: "n1", status: "complete" });
    const { router } = await mount({
      nodes: [root],
      contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
      path: "/r/t1?ws=w1&sel=n1&highlight=h1",
    });
    await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer shows");
    // The account menu's Settings.
    fireEvent.click(screen.getByRole("button", { name: "raymond" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await waitUntil(t, () => router.state.location.pathname === "/settings", "Settings opens");
    t.deepEqual(router.state.location.search, { ws: "w1" });
    // The sidebar's Home and Highlights links.
    for (const name of ["Home", "Highlights"]) {
      const href = screen.getByRole("link", { name }).getAttribute("href") ?? "";
      t.is(new URL(href, "http://localhost").search, "?ws=w1", name);
    }
  },
);

test.serial("Ask as a question sends the chosen model and effort", async (t) => {
  const note = post();
  const created: ResearchTreeDetail = {
    tree: tree({ id: "t9", rootNodeId: "n9" }),
    nodes: [node({ id: "n9", treeId: "t9" })],
  };
  const { trpc } = await mount({
    nodes: [note],
    contentByNode: {},
    path: "/r/t1?node=n1&edit=n1",
    responses: { "research.createTree": created },
  });
  await waitFor(() => screen.getByRole("textbox", { name: "Note text" }));
  // The ask boxes' picker: the model's icon and name, then the Effort submenu.
  const trigger = screen.getByTitle("Model for the question");
  t.is(trigger.getAttribute("aria-label"), "Model: Gemini 3.8 Flash, Medium effort");
  fireEvent.click(trigger);
  // Labelled by its trigger.
  const menu = await screen.findByRole("menu");
  t.deepEqual(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim()),
    ["Gemini 3.8 Flash", "GPT-5.6 Luna", "EffortDefault"],
  );
  fireEvent.click(within(menu).getByRole("menuitem", { name: /^Effort/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));
  await waitUntil(
    t,
    () =>
      screen.getByTitle("Model for the question").getAttribute("aria-label") ===
      "Model: Gemini 3.8 Flash, High effort",
    "the effort is chosen",
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask as a question" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "research.createTree"),
    "the question is asked",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "research.createTree")?.input, {
    prompt: "A note about memory",
    model: "gemini-flash",
    effort: "high",
    workspaceId: "w1",
  });
});

test.serial(
  "Ask as a question offers to delete the original thread, then its delete confirmation",
  async (t) => {
    const note = post();
    const followUp = node({ id: "f1", parentNodeId: "n1", status: "complete" });
    const created: ResearchTreeDetail = {
      tree: tree({ id: "t9", rootNodeId: "n9" }),
      nodes: [node({ id: "n9", treeId: "t9" })],
    };
    const { trpc, router } = await mount({
      nodes: [note, followUp],
      contentByNode: {},
      path: "/r/t1?node=n1&edit=n1",
      responses: {
        "research.createTree": created,
        "research.listTrees": [
          summary({ id: "t1", title: "Collective memory", runningCount: 0 }),
          summary({ id: "t9", title: "New", runningCount: 0 }),
        ],
        "research.listTrash": [],
        "research.trashTree": { ok: true },
        "folders.get": {
          folders: [],
          membership: {},
          collapsed: [],
          parents: {},
          collapsedGroups: [],
        },
      },
    });
    await waitFor(() => screen.getByRole("textbox", { name: "Note text" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask as a question" }));
    const offer = await screen.findByRole("dialog", { name: "Delete the original thread?" });
    await waitUntil(t, () => router.state.location.pathname === "/r/t9", "the new thread opens");
    t.truthy(
      within(offer).getByText(
        "The question was asked in a new thread. The original thread, “Collective memory”, is unchanged.",
      ),
    );
    t.truthy(
      within(offer).getByText(
        "It has 1 message (a follow-up); deleting the thread also deletes it.",
      ),
    );
    t.is(document.activeElement, within(offer).getByRole("button", { name: "Keep" }));
    fireEvent.click(within(offer).getByRole("button", { name: "Delete…" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete “Collective memory”?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Move to Trash" }));
    await waitUntil(
      t,
      () => trpc.calls.some((call) => call.path === "research.trashTree"),
      "the original moves to the Trash",
    );
    t.deepEqual(trpc.calls.find((call) => call.path === "research.trashTree")?.input, {
      treeId: "t1",
    });
  },
);

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

/* ------------------------------------------------- review round 2 parity */

function queuedItem(overrides: Partial<ResearchFollowupQueueItem> = {}): ResearchFollowupQueueItem {
  return {
    id: "q1",
    treeId: "t1",
    headNodeId: "n1",
    authorId: "u1",
    message: { text: "A queued question" },
    agent: { adapter: "gemini", model: "gemini-flash", effort: null },
    position: 0,
    createdAt: 1_700_000_000_000,
    failedReason: null,
    ...overrides,
  };
}

const IMAGE = { kind: "image" as const, id: "img1", mimeType: "image/png", byteSize: 10 };

test.serial("Edit question on a stalled queued item moves it into the ask box", async (t) => {
  const root = node({ id: "n1", status: "failed", error: "Stopped." });
  const { trpc } = await mount({
    nodes: [root],
    queues: {
      n1: [queuedItem({ message: { text: "A queued question", attachments: [IMAGE] } })],
    },
    contentByNode: { n1: contentFor(root, [], { responseRevision: undefined }) },
    responses: { "followups.cancel": [] },
  });
  await waitUntil(t, () => screen.queryByText("A queued question") !== null, "the item shows");
  const row = screen.getByText("A queued question").closest("li") as HTMLElement;
  t.truthy(within(row).getByText("The last answer stopped; retry it, or edit this question."));

  // Only into an empty ask box, as on the desktop.
  const field = screen.getByRole("textbox", { name: "Follow-up in this conversation" });
  fireEvent.change(field, { target: { value: "Something else" } });
  fireEvent.click(within(row).getByRole("button", { name: "Edit question" }));
  await waitUntil(
    t,
    () => screen.queryByText("Clear the ask box to edit this question.") !== null,
    "the toast",
  );
  t.false(trpc.calls.some((call) => call.path === "followups.cancel"));

  fireEvent.change(field, { target: { value: "" } });
  fireEvent.click(within(row).getByRole("button", { name: "Edit question" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "followups.cancel"),
    "the item leaves the queue",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "followups.cancel")?.input, { itemId: "q1" });
  await waitUntil(
    t,
    () =>
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Follow-up in this conversation",
      }).value === "A queued question",
    "its text is in the ask box",
  );
  t.truthy(document.querySelector('img[src*="img1"]'), "with its image");
});

test.serial("Edit question on a failed answer brings its images back", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const failed = node({
    id: "n2",
    parentNodeId: "n1",
    inline: true,
    status: "failed",
    prompt: "A failed question",
    attachments: [IMAGE],
  });
  await mount({
    nodes: [root, failed],
    contentByNode: {
      n1: contentFor(root, [assistantTurn("t1", "Root answer.")]),
      n2: contentFor(failed, [], { responseRevision: undefined }),
    },
  });
  fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Edit question" })));
  const field = await waitFor(() =>
    screen.getByRole("textbox", { name: "Edit the failed question" }),
  );
  const composer = field.closest("[data-research-composer]") as HTMLElement;
  t.truthy(composer.querySelector('img[src*="img1"]'), "the image is in the ask box");
});

test.serial("an imported report shows no citation handles", async (t) => {
  const report = node({ id: "n1", type: "document", status: "complete" });
  await mount({
    nodes: [report],
    contentByNode: {
      n1: contentFor(report, [
        assistantTurn("t1", "Bloom filters trade space for error.citeturn0search3"),
      ]),
    },
  });
  await waitUntil(
    t,
    () => screen.queryByText(/Bloom filters trade space for error\./) !== null,
    "the report renders",
  );
  t.false(document.body.textContent?.includes("turn0search3") ?? true);
});

test.serial("a running answer shows its tool calls open", async (t) => {
  const running = node({ id: "n1", status: "running" });
  await mount({
    nodes: [running],
    contentByNode: { n1: contentFor(running, [searchTurn("t1")], { seq: 1 }) },
  });
  fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Show trace" })));
  await waitUntil(t, () => document.querySelector("details") !== null, "the activity renders");
  t.true(
    (document.querySelector("details") as HTMLDetailsElement).open,
    "as the desktop's expandActivities",
  );
});

test.serial("Generate recap is offered only for an answer that has a recap", async (t) => {
  const plain = node({ id: "n1", status: "complete", completedAt: 1_700_000_050_000 });
  await mount({
    nodes: [plain],
    contentByNode: { n1: contentFor(plain, [assistantTurn("t1", "An answer.")]) },
  });
  await waitUntil(t, () => screen.queryByText("An answer.") !== null, "the answer renders");
  fireEvent.click(screen.getAllByRole("button", { name: "Answer actions" })[0] as HTMLElement);
  await waitFor(() => screen.getByRole("menu"));
  t.is(screen.queryByRole("menuitem", { name: "Generate recap" }), null);
});

test.serial("the root note's menu has no Delete", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  const note = {
    ...root,
    type: "post",
    format: "text",
    message: { text: "A root note" },
  } as unknown as ResearchNode;
  await mount({ nodes: [note], contentByNode: {} });
  const trigger = await waitFor(() => screen.getAllByRole("button", { name: /actions/i })[0]);
  fireEvent.click(trigger as HTMLElement);
  await waitFor(() => screen.getByRole("menu"));
  t.truthy(screen.getByRole("menuitem", { name: "Copy note" }));
  t.is(screen.queryByRole("menuitem", { name: /^Delete/ }), null);
});

test.serial("the root ask box reads its draft back from the server", async (t) => {
  const root = node({ id: "n1", status: "complete" });
  await mount({
    nodes: [root],
    contentByNode: { n1: contentFor(root, [assistantTurn("t1", "Root answer.")]) },
    responses: {
      "interfaceDrafts.get": (input: { key: string }) => ({
        value:
          input.key === "node:tree:t1"
            ? JSON.stringify({ text: "Written on another device", updatedAt: 5 })
            : null,
      }),
    },
  });
  await waitUntil(
    t,
    () =>
      screen.queryByRole<HTMLTextAreaElement>("textbox", {
        name: "Follow-up in this conversation",
      })?.value === "Written on another device",
    "the saved draft fills the ask box",
  );
  t.pass();
});

test.serial("a thread that is gone says so without its id", async (t) => {
  const queryClient = testQueryClient();
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  await renderApp("/r/t1", {
    queryClient,
    responses: {
      "research.getTree": () => {
        throw Object.assign(new Error("research tree t1 was not found"), {
          data: { code: "NOT_FOUND" },
        });
      },
      "system.runtimeConfig": { version: "0.0.0", models: MODELS, limits: {}, features: {} },
    },
  });
  await waitUntil(
    t,
    () => screen.queryByText("This thread was deleted or is no longer shared with you.") !== null,
    "the readable message",
  );
  t.is(screen.queryByText(/was not found/), null);
});
