// What `/healthz` answers (`13-deployment-fly.md` §5).
//
// Fly routes to a machine as soon as its check passes, so the check has to be
// false for the whole window in which the process exists but cannot serve:
// before migrations and boot reconciliation finish, and again from the moment
// `SIGTERM` starts the drain until the process exits. A request that arrives in
// either window would otherwise be admitted and then dropped.

export type HealthState = "starting" | "ready" | "draining";

export interface Readiness {
  state(): HealthState;
  /** Migrations, backfills, and run reconciliation are done. */
  ready(): void;
  /** `SIGTERM` arrived: fail the check so the proxy stops sending work while
   * the open attempts persist their checkpoints. */
  drain(): void;
}

export function createReadiness(initial: HealthState = "starting"): Readiness {
  let state = initial;
  return {
    state: () => state,
    ready() {
      // A drain that started before boot finished stays a drain.
      if (state === "starting") {
        state = "ready";
      }
    },
    drain() {
      state = "draining";
    },
  };
}
