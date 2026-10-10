// Column widths of the research strip. The feed, the messages-side columns
// (a level's messages column, a post's thread column, a pending branch, a
// draft) and the answer-side columns (a level's answer column, a post's own
// column, the editor) each have one width. Each width is automatic (a share of
// the column area's width) until its resize handle sets it; a set width is
// kept per device and applies to every column of its kind, at every level.

/** The kinds of column that share a width. */
export type ResearchColumnWidthKind = "feed" | "turns" | "answer";

export type ResearchColumnWidths = Record<ResearchColumnWidthKind, number>;

/** Widths set with the resize handles; null is the automatic width. */
export type ResearchStoredColumnWidths = Record<ResearchColumnWidthKind, number | null>;

const RESEARCH_COLUMN_WIDTH_KINDS: readonly ResearchColumnWidthKind[] = ["feed", "turns", "answer"];

export const RESEARCH_COLUMN_WIDTH_KEYS: Readonly<Record<ResearchColumnWidthKind, string>> = {
  feed: "session.research.feedWidth",
  turns: "session.research.turnsWidth",
  answer: "session.research.answerWidth",
};

const clampWidth = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));

/** Column widths from the strip's width alone (the column area: the window
 * less the sidebar), so opening, closing or switching a level never resizes
 * a column: the feed is 21% (240–300px), each pair's messages column 18%
 * (220–280px) and its answer column 44% (340–660px). */
export function researchColumnWidths(stripWidth: number): ResearchColumnWidths {
  const width = Number.isFinite(stripWidth) ? Math.max(0, stripWidth) : 0;
  return {
    feed: clampWidth(width * 0.21, 240, 300),
    turns: clampWidth(width * 0.18, 220, 280),
    answer: clampWidth(width * 0.44, 340, 660),
  };
}

/** The range a resize handle can set. The minimums are the automatic
 * minimums. The feed is at most 560px and half the column area; a messages
 * column at most 560px and an answer column at most 960px, past which lines
 * get too long to read (the strip scrolls sideways, so the column area does
 * not bound them). */
export function researchColumnWidthBounds(
  kind: ResearchColumnWidthKind,
  stripWidth: number,
): { min: number; max: number } {
  switch (kind) {
    case "feed": {
      const half = Number.isFinite(stripWidth) ? Math.floor(stripWidth / 2) : 0;
      return { min: 240, max: Math.max(240, Math.min(560, half)) };
    }
    case "turns":
      return { min: 220, max: 560 };
    case "answer":
      return { min: 340, max: 960 };
  }
}

/** The width each kind of column is shown at: the set width, clamped to its
 * range, or the automatic width. */
export function shownResearchColumnWidths(
  stored: ResearchStoredColumnWidths,
  stripWidth: number,
): ResearchColumnWidths {
  const automatic = researchColumnWidths(stripWidth);
  const shown = { ...automatic };
  for (const kind of RESEARCH_COLUMN_WIDTH_KINDS) {
    const width = stored[kind];
    if (width != null) {
      const { min, max } = researchColumnWidthBounds(kind, stripWidth);
      shown[kind] = clampWidth(width, min, max);
    }
  }
  return shown;
}

/** A stored width: a positive number of pixels, else null (unset or not a
 * width). */
export function parseStoredColumnWidth(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

export function loadResearchColumnWidths(): ResearchStoredColumnWidths {
  const read = (kind: ResearchColumnWidthKind) => {
    try {
      return parseStoredColumnWidth(localStorage.getItem(RESEARCH_COLUMN_WIDTH_KEYS[kind]));
    } catch {
      return null;
    }
  };
  return { feed: read("feed"), turns: read("turns"), answer: read("answer") };
}

export function saveResearchColumnWidth(kind: ResearchColumnWidthKind, width: number | null) {
  try {
    if (width == null) localStorage.removeItem(RESEARCH_COLUMN_WIDTH_KEYS[kind]);
    else localStorage.setItem(RESEARCH_COLUMN_WIDTH_KEYS[kind], String(Math.round(width)));
  } catch {
    // Storage unavailable: the width lasts until the window reloads.
  }
}

/** The width kind of a strip column from its `data-research-pair` value
 * (columnAttributes); the feed has no pair value. */
export function researchColumnWidthKind(pair: string | undefined): ResearchColumnWidthKind | null {
  switch (pair) {
    case "turns":
      return "turns";
    case "answer":
    case "post":
    case "editor":
      return "answer";
    default:
      return null;
  }
}

/** One step of a resize: the column's new width and the strip's scroll
 * offset that keeps the column's left edge where it was on screen.
 *
 * A width applies to every column of its kind, so `sharedBefore` columns
 * left of the resized one change by the same amount and move its left edge
 * by `sharedBefore` times the change; the strip scrolls by that much to
 * compensate. When it can't (the scroll offset would go below 0), the edge
 * moves left, and the width follows the pointer: the handle (the left edge
 * plus the width) stays under it. `delta` is the pointer's travel since the
 * resize started, or a keyboard step. */
export function researchColumnResize({
  startWidth,
  delta,
  startScrollLeft,
  sharedBefore,
  min,
  max,
}: {
  startWidth: number;
  delta: number;
  startScrollLeft: number;
  sharedBefore: number;
  min: number;
  max: number;
}): { width: number; scrollLeft: number } {
  const shared = Math.max(0, sharedBefore);
  const scroll = Math.max(0, startScrollLeft);
  const followed =
    shared === 0 || scroll + shared * delta >= 0 ? startWidth + delta : startWidth + (delta - scroll) / (shared + 1);
  const width = clampWidth(followed, min, max);
  return { width, scrollLeft: Math.max(0, scroll + shared * (width - startWidth)) };
}

/** The empty space the strip needs after its last column so that
 * `scrollLeft` stays reachable: the part of the view right of the last
 * column. At offset 0 it needs none (the filler takes up the view's
 * remaining width). */
export function researchStripSlack(scrollLeft: number, viewWidth: number, contentRight: number): number {
  return scrollLeft <= 0 ? 0 : Math.max(0, Math.ceil(scrollLeft + viewWidth - contentRight));
}
