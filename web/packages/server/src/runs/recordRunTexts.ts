// `RunTexts` over the run records (`runTexts.ts`; `03-agents-and-research.md`
// K5): the question of a run, read through the asker's current scope. The
// run record names its thread and node (`r` for the thread's root ask); the
// question is the root's or the node's `q` (a look-up's phrase, `look`, as
// the client shows it), as `view` serves it to the person now. A run whose
// thread or node was removed, deleted or erased reads as `removed`; one whose
// thread the person can no longer read, or that never existed, as
// `unavailable`.

import { view, type Source, type StoredRecord } from "@session/mutators";

import type { RunText, RunTexts } from "./runTexts.js";

export interface RecordRunTextsDeps {
  /** The committed records (`SqliteStore`). */
  source: Source;
  /** The Session handle of an account id, or null. */
  handleOf(userId: string): string | null;
}

const gone = (r: StoredRecord | undefined) =>
  r === undefined || ((r.kind === "thread" || r.kind === "node") && (r.mod === "removed" || r.del));

export function recordRunTexts(deps: RecordRunTextsDeps): RunTexts {
  return {
    questionOf(viewerId, runId): RunText {
      const handle = deps.handleOf(viewerId);
      const run = deps.source.byKey(`run:${runId}`);
      if (run?.kind !== "run") {
        // an id the registry holds was erased with its thread
        return deps.source.idTaken(runId) ? { missing: "removed" } : { missing: "unavailable" };
      }
      const thread = deps.source.byKey(`thread:${run.th}`);
      const node = run.node === "r" ? thread : deps.source.byKey(`node:${run.node}`);
      if (gone(thread) || gone(node)) return { missing: "removed" };
      const seen =
        node && thread && view(deps.source, thread, handle)
          ? view(deps.source, node, handle)
          : null;
      if (seen?.kind === "thread") return seen.q ? { question: seen.q } : { missing: "removed" };
      if (seen?.kind === "node") {
        const text = seen.look ?? seen.q;
        return text ? { question: text } : { missing: "removed" };
      }
      return { missing: "unavailable" };
    },
  };
}
