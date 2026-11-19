// Replication tiers (AGENTS.md, "Replication"): which threads of a space a
// read serves in full, and which as summaries.

import type { StoredRecord, ThreadRec } from "@session/mutators";
import { msOf } from "@session/mutators";

import { DAY, type TierOptions } from "../protocol.js";

/** The hot window by device: the past `days`, or the newest `count`
 * threads, whichever covers more, at most `cap`. */
const WINDOWS = {
  desktop: { days: 90, count: 500, cap: 5000 },
  phone: { days: 30, count: 200, cap: 5000 },
} as const;
/** A space past this many threads serves summaries for 2 years only. */
export const SUMMARY_SPACE_LIMIT = 5000;
export const SUMMARY_MAX_AGE = 2 * 365 * DAY;

/** What a read serves of a space's threads: `full` the threads served in
 * full, `summary` the others served as summaries; a thread in neither is
 * not served. */
export interface ThreadTiers {
  full: ReadonlySet<string>;
  summary: ReadonlySet<string>;
}

/** Choose the tiers of a space's readable threads for one reader. `pinned`:
 * the threads the reader wrote or saved, and those they opened. */
export function chooseTiers(
  threads: readonly ThreadRec[],
  now: number,
  opts: TierOptions | undefined,
  pinned: ReadonlySet<string>,
): ThreadTiers {
  const window = opts?.window ?? "desktop";
  const ids = threads.map((p) => p.id);
  if (window === "full") return { full: new Set(ids), summary: new Set() };
  const newest = [...threads].sort((a, b) =>
    a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? 1 : -1,
  );
  const full = new Set<string>();
  if (window !== "summary") {
    const w = WINDOWS[window];
    const since = now - w.days * DAY;
    for (const [k, p] of newest.entries()) {
      if (full.size >= w.cap) break;
      if (k < w.count || msOf(p.createdAt) >= since) full.add(p.id);
    }
  }
  // the summary window is summaries only, pinned threads included
  if (window !== "summary") for (const p of threads) if (pinned.has(p.id)) full.add(p.id);
  const summary = new Set<string>();
  const old = threads.length > SUMMARY_SPACE_LIMIT ? now - SUMMARY_MAX_AGE : -Infinity;
  for (const p of threads) if (!full.has(p.id) && msOf(p.createdAt) >= old) summary.add(p.id);
  return { full, summary };
}

/** The thread a record of a space log belongs to, for tiering: a thread's
 * own id, its counts', its follow-ups', replies' and runs' `th`, and a hide
 * record's item's thread. Null for records that are not under a thread. */
export function threadOf(r: StoredRecord, get: (key: string) => StoredRecord | undefined) {
  switch (r.kind) {
    case "thread":
      return r.id;
    case "counts":
    case "followup":
    case "reply":
    case "run":
      return r.th;
    case "hide": {
      const it = get(r.item);
      if (!it) return null;
      return it.kind === "thread" ? it.id : "th" in it ? (it as { th: string }).th : null;
    }
    default:
      return null;
  }
}

/** Whether a summary serves the record: a thread, its counts, and the hide
 * record of the thread itself. */
export const inSummary = (r: StoredRecord) =>
  r.kind === "thread" || r.kind === "counts" || (r.kind === "hide" && r.item.startsWith("thread:"));
