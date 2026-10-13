import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchRerunMenuItem } from "../src/components/research/ResearchRerunMenuItem";
import { ResearchRerunDialog } from "../src/components/research/ResearchThreadDialogs";
import {
  canRerunResearchNode,
  canRetryResearchNode,
  RESEARCH_RERUN_PENDING_REASON,
  researchRerunBlocker,
  researchRerunConfirms,
  researchRerunDialogNode,
} from "../src/lib/researchChains";
import type { ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";
import { withWidgetDom } from "./widgetDom";

function node(id: string, fields: NodeFixture = {}): ResearchNode {
  return researchNode({ id, status: "complete", sessionReady: true, ...fields });
}

function item(
  target: ResearchNode,
  options: { parent?: ResearchNode | null; archived?: boolean; pending?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(ResearchRerunMenuItem, {
      node: target,
      parent: options.parent ?? null,
      archived: options.archived ?? false,
      pending: options.pending ?? false,
      onRerun: () => {},
    }),
  );
}

function enabled(html: string) {
  return /Rerun/.test(html) && !/disabled=""/.test(html);
}

test("Rerun is enabled for a settled question: complete, failed or cancelled", () => {
  for (const status of ["complete", "failed", "cancelled"] as const) {
    const html = item(node("q", { status }));
    assert.match(html, /role="menuitem"/);
    assert.ok(enabled(html), `${status}: ${html}`);
  }
  // Only a complete answer is replaced; its item says so.
  assert.match(item(node("q")), /replace its answer/);
  assert.doesNotMatch(item(node("q", { status: "failed" })), /title=/);
});

test("Rerun is disabled, with the reason as its title, while the run is active", () => {
  for (const status of ["starting", "running", "queued"] as const) {
    const html = item(node("q", { status }));
    assert.match(html, /disabled=""/);
    assert.match(html, /title="Wait for the answer to finish"/);
  }
  // Another relaunch request in flight.
  assert.match(item(node("q"), { pending: true }), /disabled=""/);
});

test("Rerun is absent for notes and documents, and in an archived thread", () => {
  assert.equal(item(node("note", { type: "post" })), "");
  assert.equal(item(node("doc", { type: "document" })), "");
  assert.equal(item(node("doc", { type: "document", source: "imported" })), "");
  assert.equal(item(node("q"), { archived: true }), "");
  assert.equal(item(node("q", { status: "failed" }), { archived: true }), "");
});

test("a rerun needs the answer it follows to be complete, unless it can wait behind it", () => {
  const branch = node("branch", { parentNodeId: "parent" });
  const inline = node("inline", { parentNodeId: "parent", inline: true });
  const running = node("parent", { status: "running" });
  // A branch's parent appears in another column, where it has no queue.
  assert.equal(researchRerunBlocker(branch, running), "Wait for the answer this follows to finish");
  // An inline follow-up queues behind the running answer, as Retry does.
  assert.equal(researchRerunBlocker(inline, running), null);
  for (const status of ["failed", "cancelled"] as const) {
    assert.equal(
      researchRerunBlocker(inline, node("parent", { status })),
      "The answer this follows did not complete",
    );
  }
  assert.equal(researchRerunBlocker(branch, node("parent")), null);
  // A note or document parent is treated as complete.
  assert.equal(researchRerunBlocker(branch, node("parent", { type: "post" })), null);
  assert.ok(enabled(item(inline, { parent: running })));
});

test("canRerunResearchNode extends canRetryResearchNode to complete exchanges", () => {
  for (const status of ["failed", "cancelled"] as const) {
    assert.equal(canRetryResearchNode(node("q", { status })), true);
    assert.equal(canRerunResearchNode(node("q", { status })), true);
  }
  assert.equal(canRetryResearchNode(node("q")), false);
  assert.equal(canRerunResearchNode(node("q")), true);
  for (const status of ["queued", "starting", "running"] as const) {
    assert.equal(canRerunResearchNode(node("q", { status })), false);
  }
  assert.equal(canRerunResearchNode(node("note", { type: "post" })), false);
  assert.equal(canRerunResearchNode(node("doc", { type: "document" })), false);
});

test("Rerun asks first only for a complete answer; a failed or cancelled run is retried at once", () => {
  assert.equal(researchRerunConfirms(node("q")), true);
  for (const status of ["failed", "cancelled"] as const) {
    assert.equal(researchRerunConfirms(node("q", { status })), false);
  }
});

test("the Rerun dialog is closed in an archived thread", () => {
  const target = node("q");
  assert.equal(researchRerunDialogNode(target, false), target);
  assert.equal(researchRerunDialogNode(target, true), null);
  assert.equal(researchRerunDialogNode(undefined, false), null);
});

test("the Rerun dialog says why Continue is disabled", async () => {
  await withWidgetDom(async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (target: ResearchNode, parent: ResearchNode | null, pending: boolean) =>
      act(async () =>
        root.render(
          createElement(ResearchRerunDialog, { node: target, parent, pending, onConfirm: () => {}, onClose: () => {} }),
        ),
      );
    const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const status = () => dialog().querySelector('[role="status"]')?.textContent ?? null;
    const continueButton = () =>
      [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    try {
      await render(node("q"), null, false);
      assert.match(dialog().textContent ?? "", /Rerun will replace the current answer/);
      assert.equal(status(), null);
      assert.equal(continueButton().disabled, false);

      await render(node("q"), null, true);
      assert.equal(status(), RESEARCH_RERUN_PENDING_REASON);
      assert.equal(continueButton().disabled, true);

      // A blocker takes precedence over the pending request.
      await render(node("q", { parentNodeId: "p" }), node("p", { status: "failed" }), true);
      assert.equal(status(), "The answer this follows did not complete");
      assert.equal(continueButton().disabled, true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
