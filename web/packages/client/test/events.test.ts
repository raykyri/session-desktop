import type { SessionEvent } from "@session/shared";
import { DEFAULT_USER_SETTINGS } from "@session/shared";
import test from "ava";

import { applyEventBatch, asRunEvent } from "../src/api/events.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 1_700_000_000_000 };
}

test.beforeEach(() => {
  useLiveTurnsStore.setState({ byNode: {} });
  useNotificationsStore.getState().clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS } });
});

test.serial("run events are narrowed out of the loose envelope", (t) => {
  t.deepEqual(asRunEvent(event("research.run.started", { nodeId: "n1", seq: 1 })), {
    type: "run.started",
    nodeId: "n1",
    seq: 1,
  });
  t.deepEqual(
    asRunEvent(event("research.turn.delta", { nodeId: "n1", seq: 2, text: "hi", turnId: "t1" })),
    { type: "turn.delta", nodeId: "n1", seq: 2, text: "hi", turnId: "t1" },
  );
});

test.serial("an event without a node and a sequence is not a run event", (t) => {
  t.is(asRunEvent(event("research.run.started", { nodeId: "n1" })), null);
  t.is(asRunEvent(event("research.run.started", { seq: 1 })), null);
  t.is(asRunEvent(event("encyclopedia.page.updated", { nodeId: "n1", seq: 1 })), null);
});

test.serial("a turn that does not match the schema is dropped, not cast", (t) => {
  t.is(
    asRunEvent(event("research.turn.committed", { nodeId: "n1", seq: 3, turn: { id: "t1" } })),
    null,
    "a turn missing its required fields is a malformed event",
  );

  const valid = asRunEvent(
    event("research.turn.committed", {
      nodeId: "n1",
      seq: 3,
      turn: { id: "t1", agentId: "n1", role: "assistant", blocks: [], sourceIndex: 0 },
    }),
  );
  t.is(valid?.type, "turn.committed");
});

test.serial("a batch fans out to the live buffer and the toast list", (t) => {
  useLiveTurnsStore.getState().seed("n1", { turns: [], seq: 0 });

  applyEventBatch([
    event("research.run.started", { nodeId: "n1", seq: 1 }),
    event("research.turn.delta", { nodeId: "n1", seq: 2, text: "Hel" }),
    event("research.turn.delta", { nodeId: "n1", seq: 3, text: "lo" }),
    event("notification.requested", {
      id: "toast-1",
      title: "Run finished",
      body: "Collective memory",
      tone: "success",
      timeoutMs: 5_000,
    }),
    event("workspace.updated", { workspaceId: "w1" }),
  ]);

  t.is(useLiveTurnsStore.getState().byNode["n1"]?.inFlightText, "Hello");
  t.is(useLiveTurnsStore.getState().byNode["n1"]?.lastSeq, 3);
  t.deepEqual(
    useNotificationsStore.getState().items.map((item) => item.id),
    ["toast-1"],
  );
});

test.serial("a malformed notification payload produces no toast", (t) => {
  applyEventBatch([event("notification.requested", { id: "x", title: "Only a title" })]);
  t.is(useNotificationsStore.getState().items.length, 0);
});

test.serial("a user who turned notifications off gets no toast", (t) => {
  useSettingsStore.getState().set("showNotifications", false);

  applyEventBatch([
    event("notification.requested", {
      id: "toast-1",
      title: "Run finished",
      body: "Collective memory",
      tone: "success",
      timeoutMs: 5_000,
    }),
    event("research.run.started", { nodeId: "n1", seq: 1 }),
  ]);

  t.is(useNotificationsStore.getState().items.length, 0);
  t.is(
    useLiveTurnsStore.getState().byNode["n1"]?.status,
    "running",
    "the preference silences the toast, not the run",
  );
});
