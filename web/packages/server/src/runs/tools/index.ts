// The tool set one attempt runs with (`04-agent-runtime.md` §6).
//
// The same three tools for every model, so the timeline, the Sources footer,
// and any evaluation of one model against another see the same capabilities.
// `web_search` is absent when the deployment has no search vendor, and
// a `nativeSearch` entry replaces it with Vertex's own grounding tool
// (`providers.ts`).

import type { ToolSet } from "ai";

import type { RunToolContext } from "./context.js";
import { createDocumentReadTool } from "./documentRead.js";
import { createWebFetchTool } from "./webFetch.js";
import { createWebSearchTool } from "./webSearch.js";

export interface BuildToolsOptions {
  /** Document ids attached anywhere on this node's ancestor path: a follow-up
   * may read a document its parent was given. */
  documentIds: readonly string[];
  /** Grounding replaces the owned search tool for this model. */
  nativeSearch: boolean;
  /** Provider-executed tools contributed by the model entry. */
  providerTools: ToolSet;
}

export function buildTools(
  ctx: RunToolContext,
  signal: AbortSignal,
  options: BuildToolsOptions,
): ToolSet {
  const tools: ToolSet = {};
  if (!options.nativeSearch) {
    const search = createWebSearchTool(ctx, signal);
    if (search) {
      tools["web_search"] = search;
    }
  }
  tools["web_fetch"] = createWebFetchTool(ctx, signal);
  if (options.documentIds.length > 0) {
    tools["document_read"] = createDocumentReadTool(ctx, options.documentIds);
  }
  return { ...tools, ...options.providerTools };
}

export { ToolBudget, createToolCaches } from "./context.js";
export type { RunToolContext, ToolCaches } from "./context.js";
