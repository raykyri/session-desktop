// The research document's public surface (`09-research-document-view.md`).
//
// Other tracks import `ResearchPage` from here, which the router mounts.
// Everything else is internal to the document view.

export * from "./ResearchPage.js";
export {
  assignConnectorLanes,
  buildSegmentConnectors,
  connectorElbowPath,
  resolveAnchoredCardTops,
} from "./layout.js";
export { buildSegmentView, durationLabel, timelineTurns } from "./timeline.js";
export { researchSources } from "./sources.js";
