// The web window (`01` R1, R2), computed by the server for a `window`
// snapshot of a space log: which threads are served in full, and which as
// summaries (the thread record and its counts record only).
//
// Full, per space: the threads of the last `days` days or the newest
// `threads` threads, whichever covers more, capped at `cap` (the newest
// first); plus every thread the reader wrote or saved in the past 90 days;
// plus the threads the tab opened (at most 500 ids, scope-filtered like
// everything else, since only readable records are served). Summary: every
// other thread of the past 2 years. Older threads outside the full set are
// not served.

import { DAY, isoToMs, saveKey, type Source, type ThreadRec } from "@session/mutators";

export interface WindowSettings {
  /** `SESSION_WEB_WINDOW_DAYS` (30). */
  days: number;
  /** `SESSION_WEB_WINDOW_THREADS` (100). */
  threads: number;
  /** `SESSION_WEB_WINDOW_CAP` (500). */
  cap: number;
}

export const WEB_WINDOW: WindowSettings = { days: 30, threads: 100, cap: 500 };
/** The reader's own and saved threads are full for this long. */
export const OWN_WINDOW = 90 * DAY;
/** Summaries reach back this far. */
export const SUMMARY_WINDOW = 730 * DAY;

/** The tiers of a space's threads for one reader. */
export interface ThreadTiers {
  full: Set<string>;
  summary: Set<string>;
}

const createdMs = (t: ThreadRec) => isoToMs(t.createdAt);

/** The window of space `sp` for reader `u` at `now`. */
export function windowOf(
  source: Source,
  sp: string,
  u: string | null,
  opened: readonly string[],
  now: number,
  settings: WindowSettings = WEB_WINDOW,
): ThreadTiers {
  const threads: ThreadRec[] = [];
  for (const k of source.keysIn("thread", { sp })) {
    const r = source.byKey(k);
    if (r?.kind === "thread") threads.push(r);
  }
  // newest first; equal times by id, so the window is the same on every read
  threads.sort((a, b) => createdMs(b) - createdMs(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // the window's slots go to threads with content: a thread its author
  // deleted with nothing under it (`gone`) or the owner removed is served as
  // a summary, without taking a slot (`01` R1)
  const live = threads.filter((t) => !t.gone && t.mod !== "removed");
  const recent = live.filter((t) => createdMs(t) >= now - settings.days * DAY).length;
  const take = Math.min(settings.cap, Math.max(recent, settings.threads));
  const full = new Set(live.slice(0, take).map((t) => t.id));
  const open = new Set(opened);
  for (const t of threads) {
    if (open.has(t.id)) full.add(t.id);
    if (u === null) continue;
    if (t.u === u && createdMs(t) >= now - OWN_WINDOW) full.add(t.id);
    const s = source.byKey(saveKey(u, t.id));
    if (s?.kind === "save" && isoToMs(s.createdAt) >= now - OWN_WINDOW) full.add(t.id);
  }
  const summary = new Set<string>();
  for (const t of threads)
    if (!full.has(t.id) && createdMs(t) >= now - SUMMARY_WINDOW) summary.add(t.id);
  return { full, summary };
}
