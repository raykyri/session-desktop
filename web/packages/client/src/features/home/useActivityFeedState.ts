// The feed's two pieces of remembered position (`10` §2).
//
// The scroll anchor is a row id plus its pixel offset from the viewport's top
// edge, not a scrollTop: rows are measured lazily and a live item can be
// inserted above the reader, so a raw offset means something different every
// time the list changes. It is written on a 200 ms debounce (a scroll handler
// runs every frame; the store does not need to) and flushed on `pagehide`,
// which is the last event a navigating or bfcached tab reliably gets.
//
// The new-activity counter is the other half: items that arrived above the
// row the reader was on, while they were not at the top to see them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FeedScrollAnchor } from "../../stores/navigation.js";
import { useNavigationStore } from "../../stores/navigation.js";

export const FEED_ANCHOR_DEBOUNCE_MS = 200;

/** Within this many pixels of the top, the feed counts as "at the top": new
 * items are visible, so they are not announced (`ResearchActivityFeed.tsx:818`). */
export const FEED_TOP_THRESHOLD = 60;

/**
 * How the feed's two "return to the head" controls should travel.
 *
 * The OS preference is the one consulted (the app has no motion setting of
 * its own): a several-screen animated jump is the kind of motion
 * `prefers-reduced-motion` exists to suppress. `matchMedia` is optional here because jsdom does not implement
 * it, and a missing implementation reads as "no preference stated".
 */
export function feedScrollBehavior(): ScrollBehavior {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return reduced ? "auto" : "smooth";
}

export interface FeedAnchorControl {
  /** Records the current anchor, debounced. */
  record: (anchor: FeedScrollAnchor | null) => void;
  /** Writes any pending anchor now. Call before navigating away so a click
   * that never produced a scroll event still leaves a position to restore. */
  flush: () => void;
  /** The anchor this feed was last left at, read once per mount. */
  initial: FeedScrollAnchor | null;
}

export function useFeedScrollAnchor(view: string): FeedAnchorControl {
  const recordFeedAnchor = useNavigationStore((state) => state.recordFeedAnchor);
  // Read once, on the first render of this feed: the store keeps being written
  // while the reader scrolls, and re-reading it would fight the restore.
  const [initial] = useState<FeedScrollAnchor | null>(() =>
    useNavigationStore.getState().feedAnchorFor(view),
  );

  const pendingRef = useRef<FeedScrollAnchor | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current === null) return;
    recordFeedAnchor(view, pendingRef.current);
    pendingRef.current = null;
  }, [recordFeedAnchor, view]);

  const record = useCallback(
    (anchor: FeedScrollAnchor | null) => {
      pendingRef.current = anchor;
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, FEED_ANCHOR_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush();
    };
  }, [flush]);

  // Memoized: the feed hangs a native `scroll` listener off this control, and
  // a fresh object every render would detach and re-attach that listener on
  // every commit.
  return useMemo(() => ({ record, flush, initial }), [record, flush, initial]);
}

/**
 * Counts items that appeared above the row the reader was on. The comparison is
 * against the previously known top id rather than against the list length: a
 * refetch that replaces the head with the same rows adds nothing, and a removal
 * must not read as an arrival.
 */
export function countNewAbove(
  previousTopId: string | null,
  ids: readonly string[],
  known: ReadonlySet<string>,
): number {
  if (previousTopId === null) return 0;
  const index = ids.indexOf(previousTopId);
  if (index <= 0) return 0;
  return ids.slice(0, index).filter((id) => !known.has(id)).length;
}
