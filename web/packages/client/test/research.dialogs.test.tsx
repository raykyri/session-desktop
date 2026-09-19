// The document's dialogs and the menu rows other surfaces reuse
// (`09-research-document-view.md` §8).

import { emptyResearchFolderState } from "@session/shared";
import type { ResearchNodeContent } from "@session/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { setTrpcClient } from "../src/api/trpc.js";
import { DeleteBranchDialog } from "../src/features/research/DeleteBranchDialog.js";
import { RecapDialog } from "../src/features/research/RecapDialog.js";
import {
  DeleteTreeDialog,
  RenameTreeDialog,
  ResearchTreeMenuItems,
} from "../src/features/research/treeMenu.js";
import { Menu } from "../src/ui/Menu.js";

import { node, summary, tree } from "./fixtures.js";
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
    children: [],
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

  fireEvent.click(screen.getByRole("button", { name: "Rewrite summary" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Use this summary" }));
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
    () => !screen.getByRole("button", { name: "Rewrite summary" }).hasAttribute("disabled"),
    "the default instructions load",
  );
  fireEvent.click(screen.getByRole("button", { name: "Rewrite summary" }));
  await waitUntil(
    t,
    () => screen.queryByText("A fresher summary.") !== null,
    "the candidate is shown",
  );
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Be terse." } });
  // A candidate produced from different instructions cannot be applied.
  t.is(screen.queryByRole("button", { name: "Use this summary" }), null);
  t.truthy(screen.getByText("Generate a candidate to replace the current summary."));
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
    () => !screen.getByRole("button", { name: "Rewrite summary" }).hasAttribute("disabled"),
    "the default instructions load",
  );
  fireEvent.click(screen.getByRole("button", { name: "Rewrite summary" }));
  await waitUntil(t, () => screen.queryByRole("alert") !== null, "the server's message is shown");
  t.truthy(screen.getByText("The research response has been updated; please reselect the text."));
});

/* ---------------------------------------------------------- branch deletion */

test.serial("branch deletion confirmation lists descendants that will be removed", (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({ id: "n2", parentNodeId: "n1", status: "complete", inline: false });
  const child = node({ id: "n3", parentNodeId: "n2", status: "complete", inline: false });
  render(
    <DeleteBranchDialog
      detail={{ tree: tree(), nodes: [root, branch, child] }}
      nodeId="n2"
      busy={false}
      error={null}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  t.truthy(screen.getByText("Delete this branch?"));
  t.truthy(screen.getByText(/This also permanently deletes 1 descendant follow-up\./));
  t.truthy(screen.getByRole("button", { name: "Delete branch" }));
});

test.serial("a branch with a run in flight cannot be deleted", (t) => {
  const root = node({ id: "n1", status: "complete" });
  const branch = node({ id: "n2", parentNodeId: "n1", status: "running", inline: false });
  render(
    <DeleteBranchDialog
      detail={{ tree: tree(), nodes: [root, branch] }}
      nodeId="n2"
      busy={false}
      error={null}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  t.true(screen.getByRole("button", { name: "Delete follow-up" }).hasAttribute("disabled"));
});

test.serial("deleting the root is named as deleting the research", (t) => {
  const root = node({ id: "n1", status: "complete" });
  render(
    <DeleteBranchDialog
      detail={{ tree: tree(), nodes: [root] }}
      nodeId="n1"
      busy={false}
      error={null}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  t.truthy(screen.getByRole("heading", { name: "Delete thread" }));
});

/* -------------------------------------------------------------- tree menu */

function menuFor(overrides: Partial<Parameters<typeof ResearchTreeMenuItems>[0]> = {}) {
  const calls: string[] = [];
  const items = (
    <ResearchTreeMenuItems
      tree={summary(overrides.tree ? {} : { runningCount: 0 })}
      archived={false}
      folderState={emptyResearchFolderState()}
      onToggleStar={() => calls.push("star")}
      onRename={() => calls.push("rename")}
      onArchive={() => calls.push("archive")}
      onRestore={() => calls.push("restore")}
      onDelete={() => calls.push("delete")}
      onRemoveFromFolder={() => calls.push("removeFromFolder")}
      onRequestCreateFolder={() => calls.push("createFolder")}
      {...overrides}
    />
  );
  render(
    <Menu open trigger={<button type="button">open</button>} label="Research actions">
      {items}
    </Menu>,
  );
  return calls;
}

test.serial("the tree menu offers the active-thread actions", (t) => {
  const calls = menuFor();
  for (const label of ["Star", "Rename", "Move to new folder", "Archive", "Delete"]) {
    t.truthy(screen.getByRole("menuitem", { name: new RegExp(label) }), label);
  }
  fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
  t.deepEqual(calls, ["rename"]);
});

test.serial("an archived thread offers only Unarchive and Delete", (t) => {
  menuFor({ archived: true });
  t.truthy(screen.getByRole("menuitem", { name: /Unarchive/ }));
  t.is(screen.queryByRole("menuitem", { name: /^Archive/ }), null);
  t.is(screen.queryByRole("menuitem", { name: /Rename/ }), null);
  t.truthy(screen.getByRole("menuitem", { name: /Delete/ }));
});

test.serial("a thread with a run in flight can be neither archived nor deleted", (t) => {
  menuFor({ tree: summary({ runningCount: 1 }) });
  t.is(screen.getByRole("menuitem", { name: /Archive/ }).getAttribute("data-disabled"), "");
  t.is(screen.getByRole("menuitem", { name: /Delete/ }).getAttribute("data-disabled"), "");
});

test.serial("the summary row appears only where it is offered", (t) => {
  const calls = menuFor({ onRegenerateSummary: () => undefined });
  t.truthy(screen.getByRole("menuitem", { name: /Summary…/ }));
  cleanup();
  menuFor();
  t.is(screen.queryByRole("menuitem", { name: /Summary…/ }), null);
  t.deepEqual(calls, []);
});

test.serial("renaming commits the trimmed title", (t) => {
  const renamed: [string, string][] = [];
  render(
    <RenameTreeDialog
      tree={{ id: "t1", title: "Collective memory" }}
      open
      onClose={() => undefined}
      onRename={(treeId, title) => {
        renamed.push([treeId, title]);
      }}
    />,
  );
  const input = screen.getByLabelText("Thread title");
  fireEvent.change(input, { target: { value: "  Shared recall  " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  t.deepEqual(renamed, [["t1", "Shared recall"]]);
});

test.serial("renaming to the same title is a no-op", (t) => {
  const renamed: string[] = [];
  render(
    <RenameTreeDialog
      tree={{ id: "t1", title: "Collective memory" }}
      open
      onClose={() => undefined}
      onRename={(treeId) => {
        renamed.push(treeId);
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  t.deepEqual(renamed, []);
});

test.serial("the delete dialog names the thread and stays busy while it works", (t) => {
  const removed: string[] = [];
  render(
    <DeleteTreeDialog
      tree={{ id: "t1", title: "Collective memory" }}
      open
      busy={false}
      error={null}
      onClose={() => undefined}
      onRemove={(treeId) => removed.push(treeId)}
    />,
  );
  t.truthy(screen.getByRole("heading", { name: "Delete “Collective memory”?" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete thread" }));
  t.deepEqual(removed, ["t1"]);

  cleanup();
  render(
    <DeleteTreeDialog
      tree={{ id: "t1", title: "Collective memory" }}
      open
      busy
      error="it is still running"
      onClose={() => undefined}
      onRemove={() => undefined}
    />,
  );
  t.truthy(screen.getByText("Deleting…"));
  t.truthy(screen.getByRole("alert"));
});
