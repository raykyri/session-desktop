// The answer menu's Rerun item (`09-research-document-view.md` §8), ported
// from the desktop `ResearchRerunMenuItem.tsx`: relaunches the question in
// place with the same prompt, replacing its answer (for a failed or stopped
// run, the same as Retry). Absent for notes and documents and in an archived
// thread; disabled, with the reason as its title, while the run or the answer
// it follows has not settled.

import type { ResearchNode } from "@session/shared";
import { researchRerunBlocker, researchRerunOffered } from "@session/shared/lib/researchChains";
import { nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { RotateCcw } from "lucide-react";

import { ThreadMenuItem } from "./ThreadMenuItem.js";
import { runActive } from "./runState.js";

export function RerunMenuItem({
  node,
  parent,
  archived,
  pending,
  onRerun,
}: {
  node: ResearchNode;
  parent: ResearchNode | null;
  archived: boolean;
  /** A retry or rerun request is in flight. */
  pending: boolean;
  onRerun: () => void;
}) {
  if (archived || !researchRerunOffered(node)) return null;
  // An interrupted run that stopped resuming has settled.
  const blocker = runActive(node)
    ? "Wait for the answer to finish"
    : nodeStatus(node) === "interrupted"
      ? null
      : researchRerunBlocker(node, parent);
  return (
    <ThreadMenuItem
      icon={<RotateCcw size={15} aria-hidden="true" />}
      label="Rerun"
      disabled={blocker !== null || pending}
      title={
        blocker ??
        (nodeStatus(node) === "complete"
          ? "Run this question again and replace its answer"
          : undefined)
      }
      onSelect={onRerun}
    />
  );
}
