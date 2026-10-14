import { RotateCcw } from "lucide-react";
import { researchRerunBlocker, researchRerunOffered } from "@session/shared/lib/researchChains";
import { nodeStatus } from "@session/shared/lib/researchNodeTypes";
import type { ResearchNode } from "../../types";
import { ResearchMenuItem } from "./ResearchMenu";

/** The answer menu's Rerun item: relaunches the question in place with the
 * same prompt, replacing its answer (for a failed or cancelled run, the same
 * as Retry). Absent for posts and documents and in an archived thread, as
 * the menu's other run actions are; disabled, with the reason as its title,
 * while the run or the answer it follows has not settled. `pending` is a
 * relaunch request already in flight. */
export function ResearchRerunMenuItem({
  node,
  parent,
  archived,
  pending,
  onRerun,
}: {
  node: ResearchNode;
  parent: ResearchNode | null;
  archived: boolean;
  pending: boolean;
  onRerun: () => void;
}) {
  if (archived || !researchRerunOffered(node)) {
    return null;
  }
  const blocker = researchRerunBlocker(node, parent);
  return (
    <ResearchMenuItem
      icon={<RotateCcw size={15} aria-hidden="true" />}
      label="Rerun"
      disabled={blocker !== null || pending}
      title={
        blocker ??
        (nodeStatus(node) === "complete" ? "Run this question again and replace its answer" : undefined)
      }
      onSelect={onRerun}
    />
  );
}
