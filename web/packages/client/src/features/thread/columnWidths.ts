// Column widths of a thread's strip, ported from the desktop
// `researchColumnWidths.ts`. The messages-side columns (a level's messages
// column, a branches column, a note's follow-ups column) and the answer-side
// columns (an answer column, a note column, the editor) each share one width.
// A width is automatic, a share of the strip's width, until its resize handle
// sets it; a set width is kept per browser and applies at every level. The web
// strip has no feed column: Home is its own route.

export type ColumnWidthKind = "messages" | "answer";

export type ColumnWidths = Record<ColumnWidthKind, number>;

/** Widths set with the resize handles; null is the automatic width. */
export type StoredColumnWidths = Record<ColumnWidthKind, number | null>;

const KINDS: readonly ColumnWidthKind[] = ["messages", "answer"];

export const COLUMN_WIDTH_KEYS: Readonly<Record<ColumnWidthKind, string>> = {
  messages: "session.thread.messagesWidth",
  answer: "session.thread.answerWidth",
};

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)));

/** Widths from the strip's width alone, so opening, closing or switching a
 * level never resizes a column: each messages column 18% (220–280px) and
 * each answer column 44% (340–660px). */
export function columnWidths(stripWidth: number): ColumnWidths {
  const width = Number.isFinite(stripWidth) ? Math.max(0, stripWidth) : 0;
  return {
    messages: clamp(width * 0.18, 220, 280),
    answer: clamp(width * 0.44, 340, 660),
  };
}

/** The range a resize handle can set: a messages column 220–560px, an answer
 * column 340–960px, past which lines get too long to read. */
export function columnWidthBounds(kind: ColumnWidthKind): { min: number; max: number } {
  return kind === "messages" ? { min: 220, max: 560 } : { min: 340, max: 960 };
}

/** The width each kind is shown at: the set width, clamped, or the automatic
 * width. */
export function shownColumnWidths(stored: StoredColumnWidths, stripWidth: number): ColumnWidths {
  const shown = { ...columnWidths(stripWidth) };
  for (const kind of KINDS) {
    const width = stored[kind];
    if (width != null) {
      const { min, max } = columnWidthBounds(kind);
      shown[kind] = clamp(width, min, max);
    }
  }
  return shown;
}

/** A stored width: a positive number of pixels, else null. */
export function parseStoredColumnWidth(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

export function loadColumnWidths(): StoredColumnWidths {
  const read = (kind: ColumnWidthKind) => {
    try {
      return parseStoredColumnWidth(localStorage.getItem(COLUMN_WIDTH_KEYS[kind]));
    } catch {
      return null;
    }
  };
  return { messages: read("messages"), answer: read("answer") };
}

export function saveColumnWidth(kind: ColumnWidthKind, width: number | null): void {
  try {
    if (width == null) localStorage.removeItem(COLUMN_WIDTH_KEYS[kind]);
    else localStorage.setItem(COLUMN_WIDTH_KEYS[kind], String(Math.round(width)));
  } catch {
    // Storage unavailable: the width lasts until the page reloads.
  }
}

/** The width kind of a column from its `data-research-pair` value. */
export function columnWidthKind(pair: string | undefined): ColumnWidthKind | null {
  switch (pair) {
    case "messages":
      return "messages";
    case "answer":
    case "post":
    case "editor":
      return "answer";
    default:
      return null;
  }
}

/** One step of a resize: the new width and the strip's scroll offset that
 * keeps the resized column's left edge where it was on screen. A width
 * applies to every column of its kind, so `sharedBefore` columns left of the
 * resized one move its edge; the strip scrolls by as much to compensate, and
 * when it cannot (the offset would go below 0) the width follows the pointer
 * instead. `delta` is the pointer's travel since the resize started, or a
 * keyboard step. */
export function columnResize({
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
    shared === 0 || scroll + shared * delta >= 0
      ? startWidth + delta
      : startWidth + (delta - scroll) / (shared + 1);
  const width = clamp(followed, min, max);
  return { width, scrollLeft: Math.max(0, scroll + shared * (width - startWidth)) };
}
