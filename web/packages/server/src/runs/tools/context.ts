// What the owned tools are given for one run (`04-agent-runtime.md` §6).

import type { SessionDatabase } from "@session/db";

import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";

import { ToolCache } from "./cache.js";
import type { Lookup } from "./ssrf.js";

/** Per-run tool budgets. Spent inside the tool so an exhausted budget is a
 * tool result the model reads and works around, not an aborted run. */
export const MAX_SEARCHES_PER_RUN = 20;
export const MAX_FETCHES_PER_RUN = 20;

export class ToolBudget {
  #searches = 0;
  #fetches = 0;

  constructor(
    readonly maxSearches = MAX_SEARCHES_PER_RUN,
    readonly maxFetches = MAX_FETCHES_PER_RUN,
  ) {}

  get searches(): number {
    return this.#searches;
  }

  get fetches(): number {
    return this.#fetches;
  }

  /** True when the call may proceed; the counter moves either way, so a
   * capped run cannot be nudged over the line by retries. */
  spendSearch(): boolean {
    this.#searches += 1;
    return this.#searches <= this.maxSearches;
  }

  spendFetch(): boolean {
    this.#fetches += 1;
    return this.#fetches <= this.maxFetches;
  }
}

export const SEARCH_BUDGET_SPENT =
  "The web_search invocation limit has been reached for this run. Answer using existing sources.";
export const FETCH_BUDGET_SPENT =
  "The web_fetch invocation limit has been reached for this run. Answer using previously retrieved pages.";

/** Vendor and page caches live for the process, not for one run: two runs on
 * the same topic minutes apart should not pay the vendor twice. */
export interface ToolCaches {
  search: ToolCache<unknown>;
  fetch: ToolCache<unknown>;
}

export function createToolCaches(): ToolCaches {
  return { search: new ToolCache<unknown>(), fetch: new ToolCache<unknown>() };
}

/** A usage record a tool asks the run to write (`usage_events` kind `search`
 * or `fetch`; `02-domain-model-and-database.md` §3.7). */
export type ToolUsage = (kind: "search" | "fetch", count: number) => void;

export interface RunToolContext {
  config: Config;
  db: SessionDatabase;
  userId: string;
  /** Absent for a metadata run, which has no node and no tools. */
  nodeId: string | null;
  logger: Logger;
  fetch: typeof globalThis.fetch;
  budget: ToolBudget;
  caches: ToolCaches;
  recordUsage: ToolUsage;
  /** Overridden by the SSRF tests. */
  lookup?: Lookup;
  allowHosts?: readonly string[];
}
