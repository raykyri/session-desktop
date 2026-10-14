// Helpers the `research` procedure files share.

import type { ResearchNode } from "@session/shared";

import { publish } from "../../emit.js";

/** Publishes `research.node.updated` for the node a mutation just changed,
 * with its queue position while it waits for admission. */
export function publishNode(
  ctx: Parameters<typeof publish>[0],
  node: ResearchNode,
  queuePosition?: number,
): void {
  publish(ctx, "research.node.updated", {
    node,
    ...(queuePosition === undefined ? {} : { queuePosition }),
  });
}
