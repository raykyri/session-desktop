// The web's `interrupted` status in the desktop's shared helpers: a deploy or
// crash stopped a run that the server resumes. The desktop backend never sends
// it, so these cases exist only for the web.

import test from "ava";

import { canRetryResearchNode, isActiveResearchStatus } from "../src/lib/researchChains.js";
import { researchRowState } from "../src/lib/researchRowGlyph.js";
import type { ResearchExchangeNode, ResearchNodeStatus } from "../src/wire/index.js";

function exchange(status: ResearchNodeStatus): ResearchExchangeNode {
  return {
    id: "node",
    treeId: "tree",
    groupId: "workspace",
    type: "exchange",
    message: { text: "Question" },
    agent: { adapter: "gemini", model: "gemini-flash", effort: null },
    run: { status, sessionReady: false },
    createdAt: 1,
    highlights: [],
  };
}

test("an interrupted run is active until the server resumes it", (t) => {
  t.true(isActiveResearchStatus("interrupted"));
  t.false(isActiveResearchStatus("complete"));
});

test("an interrupted run can be retried", (t) => {
  t.true(canRetryResearchNode(exchange("interrupted")));
  t.false(canRetryResearchNode(exchange("running")));
});

test("an interrupted run's row shows as running", (t) => {
  t.is(researchRowState("interrupted"), researchRowState("running"));
});
