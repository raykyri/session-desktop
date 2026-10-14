// The thread page's dialogs (`09-research-document-view.md` §8). The thread
// menu Home's cards use is `features/home/TreeMenu.tsx` (`feed.test.tsx`,
// `trash.test.tsx`).

import type { ResearchNodeContent } from "@session/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { setTrpcClient } from "../src/api/trpc.js";
import { RecapDialog } from "../src/features/research/RecapDialog.js";
import { DeleteDialog, RerunDialog } from "../src/features/thread/ThreadDialogs.js";

import { node } from "./fixtures.js";
import { waitUntil } from "./helpers.js";
import { createTrpcStub } from "./trpcStub.js";

const REVISION = "d".repeat(64);

test.afterEach.always(() => {
  try {
    cleanup();
  } finally {
    document.body.innerHTML = "";
  }
});

/* ------------------------------------------------------------ recap dialog */

function recapContent(): ResearchNodeContent {
  return {
    node: node({
      status: "complete",
      recap: { id: "r1", text: "The old summary.", responseRevision: REVISION },
    }),
    turns: [],
    responseRevision: REVISION,
  };
}

test.serial("the recap dialog generates a candidate and applies it", async (t) => {
  const stub = createTrpcStub({
    "recaps.defaultInstructions": "Write a compact recap.",
    "recaps.generateCandidate": () => ({
      id: "c1",
      text: "A fresher summary.",
      responseRevision: REVISION,
      generatedAt: 1,
      model: "gemini-flash",
      instructions: "Write a compact recap.",
    }),
    "recaps.applyCandidate": () => node({ status: "complete" }),
  });
  setTrpcClient(stub.client);
  const applied: string[] = [];

  render(
    <RecapDialog
      open
      content={recapContent()}
      onClose={() => applied.push("closed")}
      onApplied={(updated) => applied.push(updated.id)}
    />,
  );

  // The current summary is shown for comparison, and the instructions default
  // to the server's.
  t.truthy(screen.getByText("The old summary."));
  await waitUntil(
    t,
    () => screen.queryByDisplayValue("Write a compact recap.") !== null,
    "the default instructions load",
  );

  fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));
  await waitUntil(
    t,
    () => screen.queryByText("A fresher summary.") !== null,
    "the candidate is shown",
  );

  // Both calls carry the revision the dialog opened against.
  const generate = stub.calls.find((call) => call.path === "recaps.generateCandidate");
  t.like(generate?.input, {
    nodeId: "n1",
    expectedResponseRevision: REVISION,
    instructions: "Write a compact recap.",
  });

  fireEvent.click(screen.getByRole("button", { name: "Use this recap" }));
  await waitUntil(t, () => applied.length >= 2, "the candidate is applied and the dialog closes");
  const apply = stub.calls.find((call) => call.path === "recaps.applyCandidate");
  t.like(apply?.input, {
    nodeId: "n1",
    expectedResponseRevision: REVISION,
    expectedCurrentRecapId: "r1",
  });
});

test.serial("editing recap instructions clears the generated candidate", async (t) => {
  const stub = createTrpcStub({
    "recaps.defaultInstructions": "Write a compact recap.",
    "recaps.generateCandidate": () => ({
      id: "c1",
      text: "A fresher summary.",
      responseRevision: REVISION,
      generatedAt: 1,
      model: "gemini-flash",
      instructions: "Write a compact recap.",
    }),
  });
  setTrpcClient(stub.client);
  render(
    <RecapDialog
      open
      content={recapContent()}
      onClose={() => undefined}
      onApplied={() => undefined}
    />,
  );

  await waitUntil(
    t,
    () => !screen.getByRole("button", { name: "Generate candidate" }).hasAttribute("disabled"),
    "the default instructions load",
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));
  await waitUntil(
    t,
    () => screen.queryByText("A fresher summary.") !== null,
    "the candidate is shown",
  );
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Be terse." } });
  // A candidate produced from different instructions cannot be applied.
  t.is(screen.queryByRole("button", { name: "Use this recap" }), null);
  t.truthy(screen.getByText("Generate a new recap first."));
});

test.serial("the recap dialog surfaces a refusal", async (t) => {
  const stub = createTrpcStub({
    "recaps.defaultInstructions": "Write a compact recap.",
    "recaps.generateCandidate": () => {
      throw new Error("The research response has been updated; please reselect the text.");
    },
  });
  setTrpcClient(stub.client);
  render(
    <RecapDialog
      open
      content={recapContent()}
      onClose={() => undefined}
      onApplied={() => undefined}
    />,
  );
  await waitUntil(
    t,
    () => !screen.getByRole("button", { name: "Generate candidate" }).hasAttribute("disabled"),
    "the default instructions load",
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate candidate" }));
  await waitUntil(t, () => screen.queryByRole("alert") !== null, "the server's message is shown");
  t.truthy(screen.getByText("The research response has been updated; please reselect the text."));
});

/* ---------------------------------------------------------------- deletion */

function deleteDialog(
  nodes: Parameters<typeof DeleteDialog>[0]["nodes"],
  nodeId: string,
  calls: string[] = [],
  groupChildCount = 0,
) {
  render(
    <DeleteDialog
      nodes={nodes}
      nodeId={nodeId}
      rootNodeId="n1"
      treeTitle="Collective memory"
      groupChildCount={groupChildCount}
      onTrashRoot={() => {
        calls.push("trash");
        return Promise.resolve();
      }}
      onRemove={(removed) => {
        calls.push(`remove:${removed.id}`);
        return Promise.resolve();
      }}
      onClose={() => calls.push("close")}
    />,
  );
  return calls;
}

test.serial("deleting a branch names what else it removes", (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({ id: "n2", parentNodeId: "n1", status: "complete", inline: false });
  const child = node({ id: "n3", parentNodeId: "n2", status: "complete", inline: false });
  deleteDialog([root, branch, child], "n2");
  t.truthy(screen.getByText("Delete this research branch?"));
  t.truthy(screen.getByText(/This also deletes 1 follow-up under it\. This can’t be undone\./));
  t.truthy(screen.getByRole("button", { name: "Delete branch" }));
});

test.serial("a branch with a run in flight cannot be deleted", (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({ id: "n2", parentNodeId: "n1", status: "running", inline: false });
  deleteDialog([root, branch], "n2");
  t.true(screen.getByRole("button", { name: "Delete follow-up" }).hasAttribute("disabled"));
});

test.serial("deleting the research moves it to the Trash", async (t) => {
  const root = node({ id: "n1", status: "complete", title: "Collective memory" });
  const calls = deleteDialog([root], "n1");
  t.truthy(screen.getByRole("heading", { name: "Delete “Collective memory”?" }));
  t.truthy(screen.getByText("It moves to the Trash, where you can restore it."));
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  await waitUntil(t, () => calls.includes("close"), "the dialog closes");
  t.deepEqual(calls, ["trash", "close"]);
});

test.serial(
  "Delete now deletes the research permanently after a second confirmation",
  async (t) => {
    const root = node({ id: "n1", status: "complete", title: "Collective memory" });
    const calls = deleteDialog([root], "n1");
    fireEvent.click(screen.getByRole("button", { name: "Delete now" }));
    t.truthy(screen.getByRole("heading", { name: "Delete permanently?" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitUntil(t, () => calls.includes("close"), "the dialog closes");
    t.deepEqual(calls, ["remove:n1", "close"]);
  },
);

test.serial("deleting the research names the Home children that go with it", (t) => {
  const root = node({ id: "n1", status: "complete", title: "Collective memory" });
  deleteDialog([root], "n1", [], 2);
  t.truthy(screen.getByRole("heading", { name: "Delete “Collective memory” and its 2 children?" }));
  t.truthy(
    screen.getByText(
      "It moves to the Trash with its 2 children. Restoring it restores its children too.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete now" }));
  t.truthy(
    screen.getByText(
      "“Collective memory” and its 2 children will be deleted. This can’t be undone.",
    ),
  );
});

/* ------------------------------------------------------------------- rerun */

test.serial("Rerun waits for the answer it follows to finish", (t) => {
  const parent = node({ id: "n1", status: "running" });
  const child = node({ id: "n2", parentNodeId: "n1", status: "complete", inline: false });
  render(
    <RerunDialog
      node={child}
      parent={parent}
      pending={false}
      onConfirm={() => undefined}
      onClose={() => undefined}
    />,
  );
  t.truthy(screen.getByText(/Rerun will replace the current answer\. Continue\?/));
  t.truthy(screen.getByText("Wait for the answer this follows to finish"));
  t.true(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"));
});

/* -------------------------------------------------------------- tree menu */
