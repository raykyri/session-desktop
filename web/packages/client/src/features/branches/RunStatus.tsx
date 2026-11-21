// A run's state on a thread card and a branch card (02 §3.3, W3.3; 03 §1,
// E3-E5):
//
// - `queued`: "Queued"; `running`: "Researching · Step N of 4" with a pulsing
//   dot (a static dot under reduced motion), and the text streamed so far;
// - `complete`: the answer (the caller's), then the run's stop note when it
//   has one;
// - `failed`: the reason for `fail.why`;
// - `cancelled`, `interrupted`: "Stopped" / "Interrupted" with the partial
//   text.
//
// While a run is queued or running its asker gets Stop
// (`research.cancelNode`); after `failed`, `cancelled` or `interrupted` the
// asker gets Run again (`research.retryNode`, a new attempt on the model and
// effort the composer has now).

import type { RunRec } from "@session/mutators";
import { runFailureText } from "@session/shared";

import { useRunText } from "../../replica/queries.js";
import { useWrites } from "../../replica/writes.js";
import { AnswerProse } from "../feed/AnswerProse.js";
import { useFeedViewer, useRunChoice } from "../feed/FeedContext.js";

/** A run that ended without its answer: Run again applies. */
export const isStoppedRun = (run: RunRec | undefined): run is RunRec =>
  run !== undefined &&
  (run.status === "failed" || run.status === "cancelled" || run.status === "interrupted");

/** The status line of a run that has no answer to show. */
export function runStatusText(run: RunRec | undefined): string | null {
  if (!run) return null;
  switch (run.status) {
    case "queued":
      return "Queued";
    case "running":
      return `Researching · Step ${run.step + 1} of 4`;
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return runFailureText(run.fail ?? { why: "error", cls: "unknown" });
    case "complete":
      return null;
  }
}

export function RunStatus({ run }: { run: RunRec | undefined }) {
  const text = runStatusText(run);
  if (!text || !run) return null;
  return (
    <span
      className={run.status === "queued" || run.status === "running" ? "status" : "status ended"}
      role="status"
      data-run-status={run.status}
    >
      {text}
    </span>
  );
}

/** Stop and Run again, for the run's asker. */
export function RunControls({ thread, node, run }: { thread: string; node: string; run: RunRec }) {
  const { writer, me } = useFeedViewer();
  const writes = useWrites();
  const choice = useRunChoice();
  if (!writer || me === null || run.u !== me) return null;
  if (run.status === "queued" || run.status === "running")
    return (
      <button
        type="button"
        className="runbtn"
        onClick={() => void writes.send("research.cancelNode", { thread, node })}
      >
        Stop
      </button>
    );
  if (!isStoppedRun(run)) return null;
  return (
    <button
      type="button"
      className="runbtn"
      onClick={() =>
        void writes.send("research.retryNode", {
          thread,
          node,
          base: { attempt: run.attempt },
          model: choice.model,
          effort: choice.effort,
        })
      }
    >
      Run again
    </button>
  );
}

/** A run without its answer: the status line, the text it has written so
 * far (streamed or committed), and the asker's control. `pending` is shown
 * while the run has written nothing. */
export function RunProgress({
  thread,
  node,
  run,
  pending,
}: {
  thread: string;
  node: string;
  run: RunRec | undefined;
  pending?: string | undefined;
}) {
  const text = useRunText(run);
  return (
    <div className="runp">
      <p className="runln">
        <RunStatus run={run} />
        {run ? <RunControls thread={thread} node={node} run={run} /> : null}
      </p>
      {text ? (
        <AnswerProse md={text} pages={[]} className="partial" />
      ) : pending && run && (run.status === "queued" || run.status === "running") ? (
        <div className="answer">
          <p className="pending">{pending}</p>
        </div>
      ) : null}
    </div>
  );
}

/** The stop note of a run that ended `complete` before the model finished
 * (03 E5). */
export function RunNote({ run }: { run: RunRec | undefined }) {
  return run?.status === "complete" && run.note ? <p className="runnote">{run.note}</p> : null;
}
