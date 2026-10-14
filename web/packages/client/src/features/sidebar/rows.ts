// The sidebar's row recipes. String constants rather than CSS classes so the
// Tailwind sorter and the color-literal lint rule can read them (08 §2); every
// value resolves through a token.

/** A count on a sidebar row (web only): the invitations waiting on Shared
 * with me, the unread notifications on Notifications. */
export const COUNT_BADGE =
  "bg-accent text-fg-on-accent inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[11px] leading-4 font-semibold tabular-nums";

/** "2 invitations": the badge's text for assistive technology. */
export function invitationCountLabel(count: number): string {
  return `${count} ${count === 1 ? "invitation" : "invitations"}`;
}

/** "3 unread": the Notifications badge's text for assistive technology. */
export function unreadCountLabel(count: number): string {
  return `${count} unread`;
}

/** The badge's text: a large count is shown as 99+. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export const SIDEBAR_ROW =
  "flex min-h-control-md w-full min-w-0 cursor-pointer items-center gap-2 rounded-md " +
  "px-2.5 text-[length:calc(var(--fs-reading)-1px)] text-fg-secondary no-underline " +
  "transition-colors duration-[120ms] " +
  "hover:bg-surface-sidebar-hover hover:text-fg-strong " +
  "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset outline-none";

export const SIDEBAR_SECTION_HEADING =
  "flex min-h-control-sm items-center justify-between gap-2 px-2.5 text-xs font-medium text-fg-subtle";

/** The selected thread, page or route. */
export const SIDEBAR_ROW_SELECTED = "bg-surface-sidebar-hover text-fg-strong";
