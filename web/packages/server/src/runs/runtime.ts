// The owned runs of this process, assembled (`03-agents-and-research.md`
// E1-E5): the run store over the records, the service that runs attempts,
// and the dispatcher that claims queued runs. The store tells the service
// when a write stopped an attempt (a cancel, a retry, a removal), and the
// dispatcher when a write queued a run. The sync server's `pre` stage reads
// the payer facts of the run's asker through it (`03` K8).

import type { SessionDatabase } from "@session/db";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SyncService } from "../sync/service.js";

import type { Allowances } from "./allowance.js";
import { payerFacts } from "./allowance.js";
import type { Dispatcher } from "./dispatcher.js";
import { createDispatcher } from "./dispatcher.js";
import type { Ledger } from "./ledger.js";
import type { Providers } from "./providers.js";
import { RecordRunStore } from "./recordStore.js";
import type { AgentRunsService } from "./service.js";
import { createRunsService } from "./service.js";
import type { RunToolContext } from "./tools/context.js";

export interface RunsRuntimeDeps {
  config: Config;
  db: SessionDatabase;
  sync: SyncService;
  ledger: Ledger;
  allowances: Allowances;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  providers?: Providers;
  /** `session_run_failures_total{cls}` (`03` E5). */
  onFailure?: (cls: string) => void;
  now?: () => number;
  ledgerCheckpointMs?: number;
  pollMs?: number;
  backoffMs?: readonly number[];
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface RunsRuntime {
  store: RecordRunStore;
  service: AgentRunsService;
  dispatcher: Dispatcher;
  /** Stops the dispatcher and the store's watch, then drains the attempts. */
  close(): Promise<void>;
}

export function createRunsRuntime(deps: RunsRuntimeDeps): RunsRuntime {
  const store = new RecordRunStore({
    sync: deps.sync,
    db: deps.db,
    ledger: deps.ledger,
    ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
  });
  const service = createRunsService({
    config: deps.config,
    db: deps.db,
    store,
    ledger: deps.ledger,
    allowances: deps.allowances,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.ledgerCheckpointMs === undefined
      ? {}
      : { ledgerCheckpointMs: deps.ledgerCheckpointMs }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.providers ? { providers: deps.providers } : {}),
    ...(deps.toolOverrides ? { toolOverrides: deps.toolOverrides } : {}),
  });
  const dispatcher = createDispatcher({
    config: deps.config,
    store,
    ledger: deps.ledger,
    allowances: deps.allowances,
    runner: service,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
    ...(deps.backoffMs ? { backoffMs: deps.backoffMs } : {}),
  });
  store.watch({
    stopped: (runId) => service.cancel(runId),
    queued: () => dispatcher.wake(),
  });
  // `03` K8: the `pre` stage of a write that queues a run decides its payer
  // from the ledger (open rows counted), the billing setting and the keys,
  // as the dispatcher does again at the claim (K10). A handle with no
  // account has nothing to pay with.
  const budget = {
    ledger: deps.ledger,
    allowances: deps.allowances,
    limits: deps.config.limits,
    now: deps.now ?? Date.now,
  };
  deps.sync.server.setPayerFacts((handle) => {
    const userId = store.accountOf(handle);
    return userId === null
      ? { includedLeft: false, billing: "pause", keys: [] }
      : payerFacts(budget, userId);
  });
  return {
    store,
    service,
    dispatcher,
    async close() {
      dispatcher.stop();
      store.close();
      deps.sync.server.setPayerFacts(null);
      await service.drain();
    },
  };
}
