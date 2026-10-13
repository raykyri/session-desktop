// What deleting a whole research thread removes besides its root, counted
// from the tree's nodes, and the sentence the "Delete the original thread?"
// dialog (after "Ask as a question") states it with.

import { nodeType } from "./researchNodeTypes";
import type { ResearchNode } from "../types";

/** Stored replies on a note (`delivery.replies`) are not shown in the app, so
 * they are not counted. */
export interface ResearchTreeContents {
  /** Nodes other than the root that continue a note's thread or a
   * conversation: a note's AI follow-ups and follow-up notes (its children
   * other than documents), and the inline follow-ups of a question or
   * document. */
  followUps: number;
  /** Branches: follow-ups of a question or document that open as a new level
   * (created from a passage or the whole answer, not inline), and a document
   * under a note. A branch's later messages count as follow-ups. */
  branches: number;
}

/** Counts the thread's contents below `rootNodeId`. Null when the root is
 * not among `nodes`. Nodes not descended from the root are ignored. */
export function researchTreeContents(
  nodes: readonly ResearchNode[],
  rootNodeId: string,
): ResearchTreeContents | null {
  const root = nodes.find((node) => node.id === rootNodeId);
  if (!root) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, ResearchNode[]>();
  for (const node of nodes) {
    if (!node.parentNodeId || node.id === rootNodeId) continue;
    const siblings = childrenOf.get(node.parentNodeId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentNodeId, [node]);
  }
  const contents: ResearchTreeContents = { followUps: 0, branches: 0 };
  const seen = new Set<string>();
  const queue: ResearchNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.id !== rootNodeId) {
      const parent = byId.get(node.parentNodeId ?? "");
      const postFollowUp = parent?.type === "post" && nodeType(node) !== "document";
      if (postFollowUp || (parent?.type !== "post" && node.inline)) contents.followUps += 1;
      else contents.branches += 1;
    }
    queue.push(...(childrenOf.get(node.id) ?? []));
  }
  return contents;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The dialog's sentence on what deleting the thread also deletes: its
 * messages below the root (follow-ups and branches), e.g. "It has 5 messages
 * (4 follow-ups and 1 branch); deleting the thread also deletes them." With
 * nothing below the root: "It has no follow-ups." */
export function researchTreeContentsSentence(contents: ResearchTreeContents): string {
  const messages = contents.followUps + contents.branches;
  if (messages === 0) {
    return "It has no follow-ups.";
  }
  const kinds =
    contents.followUps > 0 && contents.branches > 0
      ? `${counted(contents.followUps, "follow-up", "follow-ups")} and ${counted(contents.branches, "branch", "branches")}`
      : contents.followUps > 0
        ? messages === 1 ? "a follow-up" : "all follow-ups"
        : messages === 1 ? "a branch" : "all branches";
  return `It has ${counted(messages, "message", "messages")} (${kinds}); deleting the thread also deletes ${
    messages === 1 ? "it" : "them"
  }.`;
}
