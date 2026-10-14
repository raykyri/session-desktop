// The deletion job: deletes the rows of threads marked deleted (Delete now,
// Empty Trash, removing a workspace) a bounded step at a time
// (`deletion.step` in `@session/db`).
//
// Each step is one short transaction, and the next is scheduled with
// `setImmediate`, so requests and run writes that arrived meanwhile get the
// database between two steps. The job keeps no state of its own: it is
// kicked at boot, which resumes whatever a restart interrupted, and after
// every procedure that marks threads; a kick while it runs is absorbed.

import type { SessionDatabase } from "@session/db";
import { deletion } from "@session/db";

import type { Logger } from "../logger.js";

export interface DeletionJob {
  /** Starts the job if it is not running. */
  kick(): void;
  /** Resolves once nothing is left to delete (at once when idle). */
  idle(): Promise<void>;
  /** Stops scheduling steps; a running step finishes. */
  stop(): void;
}

export interface DeletionJobOptions {
  limits?: deletion.StepLimits;
  /** How long to wait before trying again after a step threw. */
  retryMs?: number;
  /** The step, replaceable by a test. */
  step?: typeof deletion.step;
}

export function createDeletionJob(
  deps: { db: SessionDatabase; logger?: Logger | undefined },
  options: DeletionJobOptions = {},
): DeletionJob {
  const limits = options.limits ?? deletion.DEFAULT_STEP_LIMITS;
  const retryMs = options.retryMs ?? 30_000;
  const runStep = options.step ?? deletion.step;
  let running = false;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let waiters: (() => void)[] = [];

  const settle = () => {
    running = false;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  const tick = () => {
    if (stopped) {
      settle();
      return;
    }
    let result: ReturnType<typeof deletion.step>;
    try {
      result = runStep(deps.db, limits);
    } catch (error) {
      // A failing step would fail again at once; wait, then retry. The rows
      // stay marked, so nothing reappears meanwhile.
      deps.logger?.error({ error }, "a deletion step failed");
      settle();
      retry = setTimeout(() => {
        retry = null;
        job.kick();
      }, retryMs);
      retry.unref();
      return;
    }
    if (result === null) {
      settle();
      return;
    }
    if (result.finished) {
      deps.logger?.info(
        result.treeId === null ? { workspaceId: result.workspaceId } : { treeId: result.treeId },
        result.treeId === null ? "deleted a removed workspace" : "deleted a thread's rows",
      );
    }
    setImmediate(tick);
  };

  const job: DeletionJob = {
    kick() {
      if (running || stopped) {
        return;
      }
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      running = true;
      setImmediate(tick);
    },
    idle() {
      if (!running) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    stop() {
      stopped = true;
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
    },
  };
  return job;
}
