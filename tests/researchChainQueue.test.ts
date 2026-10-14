// The thread page's queues come from the backend: the tree's stored queues,
// then every `research.queue.changed` event, and the queue a cancel or retry
// returns. Renders useResearchChainQueue against a stub backend.

import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useResearchChainQueue } from "../src/hooks/useResearchChainQueue";
import { publishResearchQueueChanged } from "../src/lib/researchQueue";
import { parseResearchEvent } from "@session/shared/lib/researchEvents";
import type { ResearchFollowupQueueItem } from "../src/types";
import { withWidgetDom } from "./widgetDom";

function item(
  id: string,
  headNodeId: string,
  position: number,
  extra: Partial<ResearchFollowupQueueItem> = {},
): ResearchFollowupQueueItem {
  return {
    id,
    treeId: "tree",
    headNodeId,
    message: { text: `Question ${id}` },
    agent: { adapter: "claude" },
    position,
    createdAt: position + 1,
    failedReason: null,
    ...extra,
  };
}

/** A queue event as the backend emits it, through the shared parser. */
function queueEvent(treeId: string, headNodeId: string, items: ResearchFollowupQueueItem[]) {
  const parsed = parseResearchEvent({
    type: "research.queue.changed",
    paneId: null,
    agentId: null,
    payload: { treeId, headNodeId, items },
    timestamp: Date.now(),
  });
  assert.equal(parsed.kind, "event");
  if (parsed.kind !== "event" || parsed.event.type !== "research.queue.changed") {
    throw new Error("not a queue event");
  }
  return parsed.event;
}

test("the thread page shows the backend's queues and applies their changes", async () => {
  await withWidgetDom(async () => {
    let resolveList!: (queues: Record<string, ResearchFollowupQueueItem[]>) => void;
    const calls: { command: string; args: unknown }[] = [];
    const image = { kind: "image" as const, id: `${"1".padStart(32, "0")}.png`, mimeType: "image/png", byteSize: 4 };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          switch (command) {
            case "list_research_followups":
              return new Promise((resolve) => {
                resolveList = resolve;
              });
            case "cancel_research_followup":
              return [item("b2", "branch", 0)];
            case "retry_research_followup":
              return [item("r1", "root", 0)];
            default:
              throw new Error(`unexpected command ${command}`);
          }
        },
      },
    });

    let hooks!: ReturnType<typeof useResearchChainQueue>;
    function Harness() {
      hooks = useResearchChainQueue({ treeId: "tree", focusComposer: () => undefined });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Harness)));
      assert.deepEqual(calls, [{ command: "list_research_followups", args: { treeId: "tree" } }]);

      // An event that arrives before the list is newer than it.
      await act(async () => {
        publishResearchQueueChanged(queueEvent("tree", "root", [item("r1", "root", 0)]));
        // Another tree's change is not this page's.
        publishResearchQueueChanged(queueEvent("other", "x", [item("x1", "x", 0)]));
      });
      await act(async () => {
        resolveList({
          root: [item("stale", "root", 0)],
          branch: [
            item("b1", "branch", 0, { message: { text: "With image", attachments: [image] } }),
            item("b2", "branch", 1, { failedReason: "The folder is unavailable." }),
          ],
        });
      });
      assert.deepEqual(hooks.queues, {
        root: [{ id: "r1", prompt: "Question r1", createdAt: 1 }],
        branch: [
          { id: "b1", prompt: "With image", createdAt: 1, images: [image] },
          { id: "b2", prompt: "Question b2", createdAt: 2, failed: "The folder is unavailable." },
        ],
      });

      // Cancel shows the queue the backend returns; the next item moved up.
      await act(async () => {
        await hooks.cancelQueued("branch", "b1");
      });
      assert.deepEqual(calls[calls.length - 1], { command: "cancel_research_followup", args: { itemId: "b1" } });
      assert.deepEqual(hooks.queues.branch, [{ id: "b2", prompt: "Question b2", createdAt: 1 }]);

      // A queue that drained is removed.
      await act(async () => {
        publishResearchQueueChanged(queueEvent("tree", "branch", []));
      });
      assert.equal(hooks.queues.branch, undefined);

      // A question just queued shows before its event, once.
      await act(async () => {
        hooks.showQueued(item("r2", "root", 1));
        hooks.showQueued(item("r2", "root", 1));
      });
      assert.deepEqual(hooks.queues.root?.map((entry) => entry.id), ["r1", "r2"]);

      await act(async () => {
        await hooks.retryQueued("root", "r1");
      });
      assert.deepEqual(calls[calls.length - 1], { command: "retry_research_followup", args: { itemId: "r1" } });
      assert.deepEqual(hooks.queues.root?.map((entry) => entry.id), ["r1"]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
