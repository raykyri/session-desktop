// The seam between the API and the agent loop.
//
// Phase 3 owns admission in the database: a launch writes the node, enqueues
// it in `run_queue`, and emits the events. Phase 4 owns everything after that
// — claiming the queue, opening the provider stream, writing turns — and
// implements this interface (`04-agent-runtime.md` §2). Until it exists the
// no-op implementation leaves admitted nodes `queued`, which is a state the
// client already renders (`05-run-lifecycle-and-streaming.md` §3).

/** A run on `gemini-flash` that produces a title, a recap, or an encyclopedia
 * page rather than an answer (`04-agent-runtime.md` §9). It has no node of its
 * own, so it cannot be addressed by node id like a research run. */
export type MetadataJob =
  | { kind: "title"; userId: string; nodeId: string }
  | { kind: "recap"; userId: string; nodeId: string; instructions?: string }
  | { kind: "encyclopedia"; userId: string; workspaceId: string; slug: string };

export interface RunsService {
  /** A node has been admitted and enqueued; wake the claim loop. */
  start(nodeId: string): void;
  /** The node's status has already been written; abort its provider stream if
   * one is open. */
  cancel(nodeId: string): void;
  /** Schedule a metadata run. Separate pool, separate concurrency. */
  enqueueMetadata(job: MetadataJob): void;
  /** `SIGTERM`: stop admitting, persist checkpoints, mark open attempts
   * `interrupted` with `resume_pending` (`05` §7). Resolves when it is safe to
   * exit. */
  drain(): Promise<void>;
}

export interface NoopRunsService extends RunsService {
  /** What the API asked for, in order. Phase 3's tests assert on this instead
   * of on a provider stream. */
  readonly started: string[];
  readonly cancelled: string[];
  readonly metadata: MetadataJob[];
  readonly drained: boolean;
}

/** Records the calls and does nothing else. */
export function createNoopRunsService(): NoopRunsService {
  const started: string[] = [];
  const cancelled: string[] = [];
  const metadata: MetadataJob[] = [];
  let drained = false;
  return {
    started,
    cancelled,
    metadata,
    get drained() {
      return drained;
    },
    start(nodeId) {
      started.push(nodeId);
    },
    cancel(nodeId) {
      cancelled.push(nodeId);
    },
    enqueueMetadata(job) {
      metadata.push(job);
    },
    drain() {
      drained = true;
      return Promise.resolve();
    },
  };
}
