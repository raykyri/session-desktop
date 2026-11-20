// The wire `AgentSpec` on the web. The desktop names a CLI agent adapter, a
// model and an effort; the web names a registry entry: `adapter` is the
// entry's model family (`ModelEntry.adapter`), `model` the registry id, and
// `effort` the reasoning effort the run was asked for (null: the model's
// default).

import { nodeAgent } from "../lib/researchNodeTypes.js";
import type { AgentSpec, ResearchNode } from "../wire/index.js";

import { DEFAULT_MODEL_ID, findModel } from "./registry.js";

/** The AgentSpec for a registry model. An unknown id keeps the id as its
 * adapter, so the spec still round-trips. */
export function agentSpecFor(modelId: string, effort?: string | null): AgentSpec {
  return {
    adapter: findModel(modelId)?.adapter ?? modelId,
    model: modelId,
    effort: effort ?? null,
  };
}

/** The registry id of a node's agent: an exchange's model, or the model a
 * post's or document's follow-ups default to. */
export function nodeModelId(node: ResearchNode): string {
  return nodeAgent(node)?.model ?? DEFAULT_MODEL_ID;
}

/** The effort a node's agent was asked for, or null for the model's default. */
export function nodeEffort(node: ResearchNode): string | null {
  return nodeAgent(node)?.effort ?? null;
}
