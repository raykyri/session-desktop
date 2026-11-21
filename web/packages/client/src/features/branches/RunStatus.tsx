// A run's status while it is not answered (02 §3.3): "Queued", or
// "Researching · Step N of 4" with a pulsing dot (a static dot under reduced
// motion). The stopped and failed states are M5a's (W3.3).

import type { RunRec } from "@session/mutators";

export function runStatusText(run: RunRec | undefined): string | null {
  if (!run) return null;
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return `Researching · Step ${run.step + 1} of 4`;
  return null;
}

export function RunStatus({ run }: { run: RunRec | undefined }) {
  const text = runStatusText(run);
  return text ? (
    <span className="status" role="status">
      {text}
    </span>
  ) : null;
}
