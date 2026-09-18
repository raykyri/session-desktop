import { isEditableTarget } from "@session/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  applySearchHighlights,
  clearSearchHighlights,
  collectSearchRanges,
  nearestSearchRangeIndex,
  scrollSearchRangeIntoView,
} from "../lib/transcriptSearch.js";
import { OVERLAY_PRIORITY } from "../stores/overlays.js";

import { FindBar } from "./FindBar.js";
import { useOverlay } from "./useOverlay.js";

export interface DomSearchBarProps {
  /** False while the host surface is not the one Cmd-F belongs to. */
  active: boolean;
  placeholder: string;
  /** The rendered text root that is searched. */
  rootRef: RefObject<HTMLElement | null>;
  /** The scroll container matches are brought into view inside. */
  viewportRef?: RefObject<HTMLElement | null>;
  /** The subtree whose editable targets still belong to this search. */
  hotkeyScopeRef?: RefObject<HTMLElement | null>;
  /** Changing this closes the bar: a new document should not inherit an open
   * find bar from the previous one. */
  resetKey?: unknown;
  className?: string;
}

/**
 * Cmd-F search over rendered content, ported from the desktop `DomSearchBar.tsx`
 * (07 §7, 08 §4). The host supplies the text root and its viewport; this owns
 * Range collection, Custom Highlight API painting, navigation, and rescans when
 * streaming content changes underneath.
 *
 * Escape is not handled with a window listener here as it was on the desktop:
 * the bar registers on the shared escape stack, so a lightbox opened over it
 * takes Escape first (07 §4.4).
 */
export function DomSearchBar({
  active,
  placeholder,
  rootRef,
  viewportRef = rootRef,
  hotkeyScopeRef = rootRef,
  resetKey,
  className,
}: DomSearchBarProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState({ index: -1, count: 0 });
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const rangesRef = useRef<Range[]>([]);
  const ownerRef = useRef<object>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suppressScrollRef = useRef(false);
  const contentRescanTimerRef = useRef<number | null>(null);

  const close = () => {
    inputRef.current?.blur();
    rangesRef.current = [];
    setResults({ index: -1, count: 0 });
    clearSearchHighlights(ownerRef.current);
    setOpen(false);
  };

  useOverlay(open && active, OVERLAY_PRIORITY.searchBar, close);

  // Blur while the input is still attached if its host unmounts. WebKit does
  // not reliably dispatch focusout after removing a focused subtree.
  useLayoutEffect(
    () => () => {
      const input = inputRef.current;
      if (input && document.activeElement === input) input.blur();
    },
    [],
  );

  // Cmd-F (or Ctrl-F) opens the bar. An editable outside this surface keeps the
  // chord for its own find. `resolveAppShortcut` deliberately does not claim
  // Cmd-F (07 §5): it belongs to whichever surface is rendered, not to the app.
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const findCombo = event.metaKey !== event.ctrlKey;
      if (
        event.defaultPrevented ||
        !findCombo ||
        event.altKey ||
        (event.key !== "f" && event.key !== "F")
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !hotkeyScopeRef.current?.contains(target) &&
        isEditableTarget(target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      // Select even when the bar is already open, matching native find.
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, hotkeyScopeRef]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // A new document closes the bar; the term and options survive so reopening
  // repeats the search. Both this and the cleared-term case below are
  // adjustments to a prop the component can see while rendering, so they happen
  // here rather than in an effect that would paint a stale frame first.
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setOpen(false);
  }

  const [lastTerm, setLastTerm] = useState(term);
  if (lastTerm !== term) {
    setLastTerm(term);
    // Clearing the field takes effect at once; typing waits out the debounce.
    if (term === "") setDebouncedTerm("");
  }

  useEffect(() => {
    if (!open) inputRef.current?.blur();
  }, [open]);

  useEffect(() => {
    if (term === "") return;
    const handle = window.setTimeout(() => setDebouncedTerm(term), 120);
    return () => window.clearTimeout(handle);
  }, [term]);

  // The rescan reads refs and writes state, so it lives behind a ref that is
  // refreshed on every commit rather than being memoized: a `useCallback` over
  // `rootRef.current` would claim a dependency it cannot actually observe.
  // This effect is declared first so the callback is current before the two
  // effects below call it.
  //
  // `contentDriven` distinguishes a rescan the user asked for (retype, toggle
  // an option), which may scroll the nearest match into view, from one the
  // streaming document forced, which must not move the reader.
  const rescanRef = useRef<(contentDriven: boolean) => void>(() => undefined);
  useEffect(() => {
    rescanRef.current = (contentDriven: boolean) => {
      const root = rootRef.current;
      const viewport = viewportRef.current;
      if (!root || !viewport) return;
      const ranges =
        debouncedTerm === ""
          ? []
          : collectSearchRanges(root, debouncedTerm, { caseSensitive, regex: useRegex });
      rangesRef.current = ranges;
      suppressScrollRef.current = contentDriven;
      setResults({ index: nearestSearchRangeIndex(viewport, ranges), count: ranges.length });
    };
  });

  useEffect(() => {
    if (open) rescanRef.current(false);
  }, [open, debouncedTerm, caseSensitive, useRegex]);

  // Rendered markdown changes without a prop this controller knows about
  // (streaming text, diagrams, expanded details). Observe the DOM and coalesce
  // those rescans without moving the reader's viewport.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const scheduleRescan = () => {
      if (debouncedTerm === "" || contentRescanTimerRef.current !== null) return;
      contentRescanTimerRef.current = window.setTimeout(() => {
        contentRescanTimerRef.current = null;
        rescanRef.current(true);
      }, 250);
    };
    const observer = new MutationObserver(scheduleRescan);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    root.addEventListener("toggle", scheduleRescan, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("toggle", scheduleRescan, true);
    };
  }, [debouncedTerm, open, rootRef]);

  useEffect(() => {
    if (open) return;
    if (contentRescanTimerRef.current !== null) {
      window.clearTimeout(contentRescanTimerRef.current);
      contentRescanTimerRef.current = null;
    }
  }, [open]);

  useEffect(
    () => () => {
      if (contentRescanTimerRef.current !== null) {
        window.clearTimeout(contentRescanTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const owner = ownerRef.current;
    if (!open || !active) {
      clearSearchHighlights(owner);
      return;
    }
    const ranges = rangesRef.current;
    applySearchHighlights(owner, ranges, results.index);
    const suppressScroll = suppressScrollRef.current;
    suppressScrollRef.current = false;
    const range = ranges[results.index];
    const viewport = viewportRef.current;
    if (range && viewport && !suppressScroll) scrollSearchRangeIntoView(viewport, range);
    return () => clearSearchHighlights(owner);
  }, [active, open, results, viewportRef]);

  const step = (delta: 1 | -1) => {
    suppressScrollRef.current = false;
    setResults((current) =>
      current.count === 0
        ? current
        : { ...current, index: (current.index + delta + current.count) % current.count },
    );
  };

  if (!open) return null;
  return (
    <FindBar
      inputRef={inputRef}
      placeholder={placeholder}
      term={term}
      onTermChange={setTerm}
      matchIndex={results.index}
      matchCount={results.count}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={setCaseSensitive}
      useRegex={useRegex}
      onUseRegexChange={setUseRegex}
      onFindNext={() => step(1)}
      onFindPrevious={() => step(-1)}
      onClose={close}
      {...(className === undefined ? {} : { className })}
    />
  );
}
