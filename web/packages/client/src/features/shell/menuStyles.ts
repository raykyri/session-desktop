// The app bar's menus as the members mockup draws them (`.menu`, `.mi`,
// `.msep`): a card with a hairline and the pop shadow, 30 px rows.

import { FOCUS_RING } from "../../ui/surfaces.js";

export const SHELL_MENU_POPUP =
  "flex min-w-[190px] flex-col rounded-lg border border-border-subtle bg-surface-card p-1 " +
  "text-fg-primary shadow-popover outline-none origin-(--transform-origin)";

export const SHELL_MENU_ITEM =
  "relative flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 " +
  "text-left text-sm whitespace-nowrap text-fg-primary data-highlighted:bg-surface-fill-hover " +
  FOCUS_RING;

export const SHELL_MENU_SEPARATOR = "mx-1.5 my-1 h-px shrink-0 bg-border-divider";

/** The rounded 30 px buttons of the bar's right side (`.hsv-e`, `.hlay`). */
export const ROUND_BUTTON =
  "inline-flex h-[30px] min-w-[30px] shrink-0 items-center justify-center rounded-[15px] " +
  "text-fg-muted shadow-[inset_0_0_0_1px_var(--surface-divider)] hover:bg-control";
