import { isActiveResearchStatus } from "./researchThreads";
import type { ResearchNodeStatus } from "../types";

interface SnappedResearchSelection {
  start: number;
  end: number;
  direction: "forward" | "backward";
}

export type ResearchSelectionSnapper = (
  anchorOffset: number,
  focusOffset: number,
) => SnappedResearchSelection | null;

interface ResearchSelectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Clips selection offsets to the end of the starting paragraph, excluding
 * trailing whitespace. Preserves the selection when clipping would leave
 * only whitespace or `paragraphEnd` is null (no paragraph found). */
export function clipResearchSelectionToParagraph(
  projection: string,
  offsets: { start: number; end: number },
  paragraphEnd: number | null,
): { start: number; end: number; crossed: boolean } {
  if (paragraphEnd === null) {
    return { ...offsets, crossed: false };
  }
  let end = paragraphEnd;
  while (end > offsets.start && /\s/.test(projection[end - 1] ?? "")) {
    end -= 1;
  }
  if (end < offsets.end && projection.slice(offsets.start, end).trim()) {
    return { start: offsets.start, end, crossed: true };
  }
  return { ...offsets, crossed: false };
}

/** A selection in an answer that is still streaming: it has no response
 * revision to anchor a highlight or branch to yet, so it can only be
 * copied. */
export function isLiveResearchSelection(responseRevision: string, status: ResearchNodeStatus | undefined) {
  return !responseRevision && status !== undefined && isActiveResearchStatus(status);
}

/** Centers the selection actions 8px above the passage if their top is at
 * or below `minTop`; otherwise places them 8px below it, constrained by the
 * viewport's bottom edge. `width` and `height` are the actions' dimensions. */
export function researchSelectionActionPlacement(input: {
  boundingRect: ResearchSelectionRect;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  /** The highest the actions may sit: below the 44px column headers. */
  minTop?: number;
}) {
  const margin = 8;
  const gap = 8;
  const rect = input.boundingRect;
  const minTop = input.minTop ?? 52;
  const maximumLeft = Math.max(margin, input.viewportWidth - input.width - margin);
  const maximumTop = Math.max(margin, input.viewportHeight - input.height - margin);
  const above = rect.top - gap - input.height;
  return {
    left: Math.round(
      Math.max(margin, Math.min(rect.left + rect.width / 2 - input.width / 2, maximumLeft)),
    ),
    top: Math.round(above >= minTop ? above : Math.min(rect.bottom + gap, maximumTop)),
    offscreen: rect.bottom < 0 || rect.top > input.viewportHeight,
  };
}

interface SelectionUnit {
  start: number;
  end: number;
}

interface WordSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

interface SegmenterLike {
  segment(input: string): Iterable<WordSegment>;
}

interface SegmenterConstructor {
  new (
    locale?: string,
    options?: { granularity: "word" | "grapheme" },
  ): SegmenterLike;
}

function segmenterConstructor() {
  return (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter ?? null;
}

/** Cuts every unit that straddles a hard boundary into per-side pieces.
 *
 * The flat rendered-text projection concatenates messages (and the rows
 * between them) with no separator, so word segmentation reads across the seam
 * and fuses one message's last word with the next one's first: `"…faster"` +
 * `"I rewrote…"` is one unit, and so is `"…faster."` + `"I…"` — a period
 * between letters does not break a word. Snapping to such a unit would drag a
 * selection into a neighbouring message, which for a conversation turn means a
 * quote spanning two speakers. Splitting at the seams keeps snapping to what it
 * advertises: each endpoint moves by at most a partial word, and which
 * messages a selection touches never changes. */
function unitsSplitAtBoundaries(units: SelectionUnit[], boundaries: number[]) {
  if (boundaries.length === 0) {
    return units;
  }
  const cuts = [...new Set(boundaries)].sort((a, b) => a - b);
  const split: SelectionUnit[] = [];
  // `units` is sorted by start, so the cut cursor only ever moves forward.
  let cursor = 0;
  for (const unit of units) {
    while (cursor < cuts.length && cuts[cursor] <= unit.start) {
      cursor += 1;
    }
    let start = unit.start;
    for (let index = cursor; index < cuts.length; index += 1) {
      const cut = cuts[index];
      if (cut >= unit.end) {
        break;
      }
      split.push({ start, end: cut });
      start = cut;
    }
    split.push({ start, end: unit.end });
  }
  return split;
}

function selectionUnits(text: string, locale?: string, boundaries: number[] = []) {
  const Segmenter = segmenterConstructor();
  if (!Segmenter) {
    return null;
  }

  try {
    const units: SelectionUnit[] = [];
    for (const part of new Segmenter(locale, { granularity: "word" }).segment(text)) {
      if (part.isWordLike) {
        units.push({ start: part.index, end: part.index + part.segment.length });
      }
    }

    // Word segmentation deliberately labels emoji as non-word content. Treat
    // each emoji grapheme as a selectable unit so a snapped drag never splits
    // a ZWJ sequence or leaves an emoji-only answer impossible to select.
    if (/\p{Extended_Pictographic}/u.test(text)) {
      for (const part of new Segmenter(locale, { granularity: "grapheme" }).segment(text)) {
        if (/\p{Extended_Pictographic}/u.test(part.segment)) {
          units.push({ start: part.index, end: part.index + part.segment.length });
        }
      }
    }

    units.sort((a, b) => a.start - b.start || a.end - b.end);
    return unitsSplitAtBoundaries(units, boundaries);
  } catch {
    // An invalid document language tag should degrade the same way as a
    // missing Segmenter: keep WebKit's native character-precise selection.
    return null;
  }
}

function firstUnitStartingAtOrAfter(units: SelectionUnit[], offset: number) {
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((units[middle]?.start ?? Number.POSITIVE_INFINITY) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Unit that supplies a selection's leading edge. At a shared boundary this
 * chooses the unit to the right; in whitespace it chooses the next unit. */
function leadingUnit(units: SelectionUnit[], offset: number) {
  const nextIndex = firstUnitStartingAtOrAfter(units, offset);
  const next = units[nextIndex];
  if (next?.start === offset) {
    return next;
  }
  const previous = units[nextIndex - 1];
  return previous && previous.end >= offset ? previous : next ?? null;
}

/** Unit that supplies a selection's trailing edge. At a shared boundary this
 * chooses the unit to the left; in whitespace it chooses the previous unit. */
function trailingUnit(units: SelectionUnit[], offset: number) {
  const nextIndex = firstUnitStartingAtOrAfter(units, offset);
  const previous = units[nextIndex - 1];
  if (previous && previous.end >= offset) {
    return previous;
  }
  const next = units[nextIndex];
  return next?.start === offset ? next : previous ?? null;
}

/** Includes punctuation attached to the outside of a snapped passage without
 * swallowing punctuation that joins it to another word. Whitespace and hard
 * projection boundaries define attachment: selecting `“quoted.”` keeps both
 * quotation marks, while selecting `state-of-the` does not pull in the hyphen
 * before `art`. */
function expandAttachedPunctuation(
  text: string,
  start: number,
  end: number,
  boundaries: number[],
) {
  let lowerBound = 0;
  let upperBound = text.length;
  for (const boundary of boundaries) {
    if (boundary <= start) {
      lowerBound = Math.max(lowerBound, boundary);
    }
    if (boundary >= end) {
      upperBound = Math.min(upperBound, boundary);
    }
  }

  const leading = text.slice(lowerBound, start).match(/\p{P}+$/u)?.[0] ?? "";
  const leadingStart = start - leading.length;
  if (
    leading &&
    (leadingStart === lowerBound || /\s$/u.test(text.slice(lowerBound, leadingStart)))
  ) {
    start = leadingStart;
  }

  const trailing = text.slice(end, upperBound).match(/^\p{P}+/u)?.[0] ?? "";
  const trailingEnd = end + trailing.length;
  if (
    trailing &&
    (trailingEnd === upperBound || /^\s/u.test(text.slice(trailingEnd, upperBound)))
  ) {
    end = trailingEnd;
  }

  return { start, end };
}

/** Expands a drag's flat rendered-text offsets to linguistic word boundaries.
 * The returned offsets are normalized, while `direction` preserves which end
 * owns the live focus. Equal offsets deliberately select one whole unit once
 * the caller's pointer-distance threshold has activated the drag.
 *
 * `boundaries` are flat offsets no unit may straddle — the seams between the
 * projection's messages and the rows around them, which carry no separating
 * whitespace of their own (see `unitsSplitAtBoundaries`). */
export function createResearchSelectionSnapper(
  text: string,
  locale?: string,
  boundaries: number[] = [],
): ResearchSelectionSnapper | null {
  const units = selectionUnits(text, locale, boundaries);
  if (!text || !units || units.length === 0) {
    return null;
  }
  return (anchorOffset, focusOffset) => {
    if (
      anchorOffset < 0 ||
      focusOffset < 0 ||
      anchorOffset > text.length ||
      focusOffset > text.length
    ) {
      return null;
    }
    const direction = focusOffset < anchorOffset ? "backward" : "forward";
    const rawStart = direction === "forward" ? anchorOffset : focusOffset;
    const rawEnd = direction === "forward" ? focusOffset : anchorOffset;
    const first = leadingUnit(units, rawStart);
    const last = trailingUnit(units, rawEnd);

    // A short drag can land in the whitespace immediately beside its anchor.
    // Keep the anchor's whole word selected rather than producing no range.
    if (!first || !last || first.start > last.start) {
      const anchor =
        leadingUnit(units, anchorOffset) ?? trailingUnit(units, anchorOffset);
      if (!anchor) {
        return null;
      }
      return {
        ...expandAttachedPunctuation(text, anchor.start, anchor.end, boundaries),
        direction,
      };
    }
    return {
      ...expandAttachedPunctuation(text, first.start, last.end, boundaries),
      direction,
    };
  };
}

export function snapResearchDragSelection(
  text: string,
  anchorOffset: number,
  focusOffset: number,
  locale?: string,
  boundaries: number[] = [],
): SnappedResearchSelection | null {
  return (
    createResearchSelectionSnapper(text, locale, boundaries)?.(
      anchorOffset,
      focusOffset,
    ) ?? null
  );
}
