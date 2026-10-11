import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchRerunMenuItem } from "../src/components/research/ResearchRerunMenuItem";
import {
  canRerunResearchNode,
  canRetryResearchNode,
  researchRerunBlocker,
} from "../src/lib/researchChains";
import type { ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

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
  const lingering = item(node("q", { status: "cancelled", holdsProcess: true }));
  assert.match(lingering, /disabled=""/);
  assert.match(lingering, /terminal is still open/);
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
  assert.equal(canRerunResearchNode(node("q", { holdsProcess: true })), false);
  for (const status of ["queued", "starting", "running"] as const) {
    assert.equal(canRerunResearchNode(node("q", { status })), false);
  }
  assert.equal(canRerunResearchNode(node("note", { type: "post" })), false);
  assert.equal(canRerunResearchNode(node("doc", { type: "document" })), false);
});
