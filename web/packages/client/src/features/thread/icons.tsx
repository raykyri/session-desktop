// Icons of the thread page, ported from the desktop `ResearchIcons.tsx`.

import { ArrowUpRight } from "lucide-react";

import { RowGlyph } from "../../ui/RowGlyph.js";

/** The branch glyph: a trunk, two nodes and the curve between them. Used
 * wherever a branch shows: a branch column's header, "Branch to right". */
export function BranchIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** The glyph of a control that selects a branch in the next column (a
 * message row's indicator, a margin marker, a passage menu's entry): an
 * up-right arrow, or the running or failed glyph while a message in those
 * branches runs or has failed. */
export function BranchOpenGlyph({
  size = 13,
  state = null,
}: {
  size?: number;
  state?: "running" | "failed" | null;
}) {
  return state ? (
    <span className="inline-flex">
      <RowGlyph kind="exchange" state={state} />
    </span>
  ) : (
    <ArrowUpRight size={size} strokeWidth={2} aria-hidden="true" />
  );
}
