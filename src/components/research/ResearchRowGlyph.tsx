import type { ReactNode } from "react";
import {
  researchRowGlyph,
  type ResearchRowGlyphShape,
  type ResearchRowKind,
  type ResearchRowState,
} from "../../lib/researchRowGlyph";

// Paths on a 14px grid. The stroke width is set in CSS (feed.css), so it is
// one value for every shape.
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
        className="research-row-glyph-pulse"
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

/** A row's 14px glyph (see researchRowGlyph.ts): feed rows give it a separate
 * column; message rows float it beside the first line. A state with a
 * name (Running, Failed, Queued, Stopped, Updated, or `label`) makes the
 * glyph an image with that name and tooltip, which the row's control reads:
 * as part of its name when the glyph is inside the labelled text, or through
 * `aria-describedby` and `id`. Otherwise it is hidden from assistive
 * technology. */
export default function ResearchRowGlyph({
  kind,
  state = "answered",
  unread = false,
  label,
  id,
}: {
  kind: ResearchRowKind;
  state?: ResearchRowState;
  unread?: boolean;
  /** Replaces the state's name, such as "Failed since last viewed". */
  label?: string;
  id?: string;
}) {
  const glyph = researchRowGlyph({ kind, state, unread });
  const name = glyph.label === null ? null : (label ?? glyph.label);
  const className = `research-row-glyph is-${glyph.shape}${glyph.tone ? ` is-tone-${glyph.tone}` : ""}`;
  // The running ring pulses its pie; another kind running pulses whole.
  const pulse = glyph.tone === "running" && glyph.shape !== "running";
  const svg = (
    <svg
      className={pulse ? "research-row-glyph-pulse" : undefined}
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[glyph.shape]}
    </svg>
  );
  if (name) {
    return (
      <span id={id} className={className} role="img" aria-label={name} title={name}>
        {svg}
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {svg}
    </span>
  );
}
