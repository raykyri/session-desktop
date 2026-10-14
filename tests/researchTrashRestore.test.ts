// Moving a thread to the Trash keeps its unsent state (drafts, pending
// branches, images, selection) and its back/forward visits
// for Restore and Undo; deleting it, from the Trash or directly, drops them.
// Renders the research data, navigation and event hooks against a stub
// backend.

import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useResearchData } from "../src/hooks/useResearchData";
import { useResearchEvents } from "../src/hooks/useResearchEvents";
import { useResearchNavigation } from "../src/hooks/useResearchNavigation";
import { useResearchNavigationState } from "../src/hooks/useResearchNavigationState";
import {
  researchNavigationStore,
  saveResearchNavigation,
  type SavedResearchNavigation,
} from "../src/lib/researchNavigation";
import type { ResearchTree, ResearchTreeSummary, SessionEvent } from "../src/types";
import { withWidgetDom } from "./widgetDom";

function summary(id: string): ResearchTreeSummary {
  return {
    id, title: id, rootNodeId: `${id}-root`, type: "exchange", workspaceId: "ws",
    runningCount: 0, failedCount: 0, completedCount: 1, cancelledCount: 0, updatedAt: 1,
    archivedAt: null, hasUnseenUpdate: false, hasUnseenFailure: false,
  };
}

function tree(id: string): ResearchTree {
  return {
    id, title: id, rootNodeId: `${id}-root`, workspaceId: "ws",
    createdAt: 1, updatedAt: 1, archivedAt: null, lastViewedAt: 1,
  };
}

function unsentState(treeId: string): SavedResearchNavigation {
  return {
    selectedNodeId: `${treeId}-b`,
    selectionPath: [`${treeId}-root`, `${treeId}-b`],
    scrollByNode: {},
    followupDraft: { text: "Draft follow-up", updatedAt: Date.now() },
    askByNode: {
      [`${treeId}-root`]: {
        anchor: {
          version: 1, projection: "answer-v1", responseRevision: "r1",
          start: 0, end: 4, exact: "text", prefix: "", suffix: "",
        },
        text: "Pending branch question",
        updatedAt: Date.now(),
      },
    },
    composerImages: {
      images: { root: [{ kind: "image", id: "image-2", mimeType: "image/png", byteSize: 20 }] },
      updatedAt: Date.now(),
    },
  };
}

const event = (type: string, payload: Record<string, unknown>): SessionEvent => ({
  type, payload, timestamp: Date.now(),
});

test("Trash then Undo keeps a thread's unsent state; deletion drops it", async () => {
  await withWidgetDom(async (window) => {
    Object.defineProperty(globalThis, "localStorage", {
      value: window.localStorage, configurable: true, writable: true,
    });
    const backend = {
      trees: [summary("kept"), summary("thread"), summary("other")],
      trash: [] as ResearchTreeSummary[],
      trashFails: false,
    };
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      switch (command) {
        case "list_research_trees": return backend.trees;
        case "list_research_activity": return [];
        case "list_recent_activity": return { items: [], nextCursor: null };
        case "list_research_trash":
          if (backend.trashFails) throw new Error("unavailable");
          return backend.trash;
        default: throw new Error(`unexpected command ${command}`);
      }
    } } });

    const store = researchNavigationStore();
    store.thread = unsentState("thread");
    store.other = unsentState("other");
    saveResearchNavigation();
    const expected = structuredClone(store.thread);

    type Hooks = {
      data: ReturnType<typeof useResearchData>;
      navigation: ReturnType<typeof useResearchNavigation>;
      state: ReturnType<typeof useResearchNavigationState>;
      handle: (event: SessionEvent) => void;
    };
    let hooks!: Hooks;
    const noop = () => undefined;
    function Harness() {
      const data = useResearchData();
      const state = useResearchNavigationState();
      const navigation = useResearchNavigation(data, state, "ws");
      const handle = useResearchEvents(data, navigation, {
        refreshResearchDrafts: noop,
        refreshResearchFolders: noop,
        refreshResearchTrash: noop,
        invalidateResearchHighlights: noop,
      });
      hooks = { data, navigation, state, handle };
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const refresh = () => act(async () => {
      await hooks.navigation.refreshResearchNavigation();
    });
    try {
      await act(async () => root.render(createElement(Harness)));
      await refresh();
      // Home, then the thread open at a message.
      await act(async () => {
        hooks.navigation.recordResearchVisit({ kind: "home" });
        hooks.navigation.recordResearchVisit({ kind: "node", treeId: "thread", nodeId: "thread-b" });
        hooks.data.setActiveResearchTree("thread");
      });

      // Move to the Trash: the thread closes, its state and visit stay.
      backend.trees = [summary("kept"), summary("other")];
      backend.trash = [{ ...summary("thread"), trashedAt: 2 }];
      await act(async () => {
        hooks.handle(event("research.tree.removed", { treeId: "thread", trashed: true }));
      });
      assert.equal(hooks.data.activeResearchTreeId, null);
      assert.deepEqual(researchNavigationStore().thread, expected);
      assert.ok(hooks.state.researchVisits.entries.some(
        (visit) => visit.kind === "node" && visit.treeId === "thread",
      ));
      // Back passes over the trashed thread's visit (Home, thread, Home).
      assert.equal(hooks.navigation.researchHistoryNav.canGoBack, false);

      // A navigation refresh lists the thread in the Trash only; one whose
      // Trash request fails prunes nothing.
      await refresh();
      backend.trashFails = true;
      await refresh();
      backend.trashFails = false;
      assert.deepEqual(researchNavigationStore().thread, expected);

      // Undo (Restore): the thread is listed again with everything it had.
      backend.trees = [summary("kept"), summary("thread"), summary("other")];
      backend.trash = [];
      await act(async () => {
        hooks.handle(event("research.tree.restored", { tree: tree("thread") }));
      });
      await refresh();
      assert.deepEqual(researchNavigationStore().thread, expected);
      assert.equal(hooks.navigation.researchHistoryNav.canGoBack, true);

      // Deleting a thread drops its state and visits and leaves the others'.
      backend.trees = [summary("kept"), summary("thread")];
      await act(async () => {
        hooks.handle(event("research.tree.removed", { treeId: "other" }));
      });
      assert.equal(researchNavigationStore().other, undefined);
      assert.deepEqual(researchNavigationStore().thread, expected);

      // Delete now from the Trash (or Empty Trash): trashed, then removed.
      backend.trees = [summary("kept")];
      backend.trash = [{ ...summary("thread"), trashedAt: 3 }];
      await act(async () => {
        hooks.handle(event("research.tree.removed", { treeId: "thread", trashed: true }));
      });
      assert.deepEqual(researchNavigationStore().thread, expected);
      backend.trash = [];
      await act(async () => {
        hooks.handle(event("research.tree.removed", { treeId: "thread" }));
      });
      assert.equal(researchNavigationStore().thread, undefined);
      assert.ok(!hooks.state.researchVisits.entries.some(
        (visit) => visit.kind === "node" && visit.treeId === "thread",
      ));
      assert.equal(
        JSON.parse(window.localStorage.getItem("session.research-navigation.v1") ?? "{}").thread,
        undefined,
      );
    } finally {
      await act(async () => root.unmount());
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
