// Run state as the thread page's controls read it.
//
// The web adds `interrupted` (the server restarted mid-run). The shared
// `isActiveResearchStatus` counts it as active, because a resume is pending in
// the common case; the server stops resuming after repeated failures and then
// clears `run.resumePending`. Controls read both: an interrupted run with a
// resume pending shows Stop and its state, one without shows Retry.

import type { ResearchNode } from "@session/shared";
import { isActiveResearchStatus } from "@session/shared/lib/researchChains";
import { nodeRun, nodeStatus } from "@session/shared/lib/researchNodeTypes";

/** The run is queued, running, or interrupted with a resume pending. */
export function runActive(node: ResearchNode): boolean {
  const status = nodeStatus(node);
  if (status === "interrupted") return nodeRun(node)?.resumePending !== false;
  return isActiveResearchStatus(status);
}

/** The run stopped without an answer and can be relaunched in place. */
export function runRetryable(node: ResearchNode): boolean {
  const status = nodeStatus(node);
  if (status === "interrupted") return nodeRun(node)?.resumePending === false;
  return status === "failed" || status === "cancelled";
}
