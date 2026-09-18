// The sidebar's row recipes. String constants rather than CSS classes so the
// Tailwind sorter and the color-literal lint rule can read them (08 §2); every
// value resolves through a token.

export const SIDEBAR_ROW =
  "flex min-h-control-md w-full min-w-0 cursor-pointer items-center gap-2 rounded-md " +
  "px-2.5 text-base text-fg-secondary no-underline transition-colors duration-[120ms] " +
  "hover:bg-surface-sidebar-hover hover:text-fg-strong " +
  "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset outline-none";

export const SIDEBAR_SECTION_HEADING =
  "flex min-h-control-sm items-center justify-between gap-2 px-2.5 text-xs text-fg-subtle";

/** The selected thread, page or route. */
export const SIDEBAR_ROW_SELECTED = "bg-surface-sidebar-hover text-fg-strong";

/** A row inside the current multi-selection. */
export const SIDEBAR_ROW_MULTI = "bg-accent-subtle text-fg-strong";
