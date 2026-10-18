// A row's 14px glyph: what a feed card or message row is (question, note,
// link, X post, draft, document) and its run state. Ported from the desktop's
// `ResearchRowGlyph.tsx`; the shape and tone rules are the shared
// `researchRowGlyph`.

import {
  researchRowGlyph,
  type ResearchRowGlyphShape,
  type ResearchRowKind,
  type ResearchRowState,
} from "@session/shared/lib/researchRowGlyph";
import { SquareChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

// Paths on a 14px grid; the stroke width is one value for every shape.
const RING = <circle cx="7" cy="7" r="5.6" />;
const SQUARE = <rect x="1.6" y="1.6" width="10.8" height="10.8" rx="2.8" />;
const PAGE = (
  <>
    <path d="M3 1.4h5.2L11 4.2v8.4H3z" />
    <path d="M8.2 1.4v2.8H11" />
  </>
);

const SHAPES: Record<ResearchRowGlyphShape, ReactNode> = {
  queued: <circle cx="7" cy="7" r="5.6" strokeDasharray="1.47 1.463" strokeLinecap="butt" />,
  running: (
    <>
      {RING}
      <path
        className="session-row-pulse"
        d="M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  answered: (
    <>
      {RING}
      <path d="M4.8 7.2l1.5 1.5 2.9-3.1" />
    </>
  ),
  unread: (
    <>
      {RING}
      <circle cx="7" cy="7" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  failed: (
    <>
      {RING}
      <path d="M7 4.3v3.2" />
      <circle cx="7" cy="9.75" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  stopped: (
    <>
      {RING}
      <path d="M5.3 5.3l3.4 3.4M8.7 5.3l-3.4 3.4" />
    </>
  ),
  note: (
    <>
      {SQUARE}
      <path d="M4.7 5.6h4.6M4.7 8.4h2.8" />
    </>
  ),
  link: (
    <>
      {SQUARE}
      <path d="M5.3 8.7l3.4-3.4M6 5.3h2.7V8" />
    </>
  ),
  xpost: (
    <>
      {SQUARE}
      <path d="M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" />
    </>
  ),
  draft: (
    <rect
      x="1.6"
      y="1.6"
      width="10.8"
      height="10.8"
      rx="2.8"
      strokeDasharray="1.6 1.6"
      strokeLinecap="butt"
    />
  ),
  imported: (
    <>
      {PAGE}
      <path d="M7 6.1v4.2M5.5 8.8 7 10.3l1.5-1.5" />
    </>
  ),
  authored: (
    <>
      {PAGE}
      <path d="M5.1 7.3h3.8M5.1 9.8h2.4" />
    </>
  ),
  transcript: (
    <>
      {PAGE}
      <path d="M5 6.9l1.5 1.3L5 9.5M7.4 10h1.7" />
    </>
  ),
};

const TONE_CLASS = {
  unread: "text-fg-secondary",
  running: "text-status-active",
  failed: "text-status-failed",
} as const;

/** A state with a name (Running, Failed, Queued, Stopped, Updated, or
 * `label`) makes the glyph an image with that name and tooltip, which the
 * row's control reads through `aria-describedby` and `id`. Otherwise it is
 * hidden from assistive technology. The untoned color is
 * `--research-row-glyph-color`, which a selected row sets. */
export function RowGlyph({
  kind,
  state = "answered",
  unread = false,
  label,
  id,
  size = 14,
  className,
  collapsed = false,
}: {
  kind: ResearchRowKind;
  state?: ResearchRowState;
  unread?: boolean;
  /** Replaces the state's name, such as "Failed since last viewed". */
  label?: string | undefined;
  id?: string | undefined;
  size?: number;
  className?: string | undefined;
  /** A collapsed note group draws a square chevron in place of the note. */
  collapsed?: boolean;
}) {
  const glyph = researchRowGlyph({ kind, state, unread });
  const name = glyph.label === null ? null : (label ?? glyph.label);
  // The running ring pulses its pie; another kind running pulses whole.
  const pulse = glyph.tone === "running" && glyph.shape !== "running";
  const classes = cn(
    "inline-flex shrink-0",
    glyph.tone
      ? TONE_CLASS[glyph.tone]
      : "text-[var(--research-row-glyph-color,var(--text-faint))]",
    className,
  );
  // Feed cards set this for a collapsed group. The note's square-and-lines
  // becomes the square chevron; every other shape stays. The stroke matches
  // the 1.5px custom shapes: Lucide's 24px grid, drawn at `size`.
  const svg = collapsed && glyph.shape === "note" ? (
    <SquareChevronRight
      className={pulse ? "session-row-pulse block" : "block"}
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      aria-hidden="true"
      data-research-row-glyph={glyph.shape}
    />
  ) : (
    <svg
      className={pulse ? "session-row-pulse block" : "block"}
      viewBox="0 0 14 14"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-research-row-glyph={glyph.shape}
    >
      {SHAPES[glyph.shape]}
    </svg>
  );
  if (name) {
    return (
      <span id={id} className={classes} role="img" aria-label={name} title={name}>
        {svg}
      </span>
    );
  }
  return (
    <span className={classes} aria-hidden="true">
      {svg}
    </span>
  );
}
