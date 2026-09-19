// The utility recipes shared by the primitive wrappers. They are string
// constants rather than CSS classes so Prettier's Tailwind plugin can sort them
// and the ESLint color-literal rule can read them; every value resolves through
// a token, so none of them names a color (08 §2).
//
// These replace the desktop's `primitives.css` (`.control-button`,
// `.icon-button`, `.menu-item`, `.popover-surface`, `.form-field`,
// `.shortcut-hint`).

export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset";

/** Pressed feedback shared by every button kind: a slight shrink that reads
 * in both appearances without a dedicated token. */
export const PRESSED = "active:not-disabled:scale-[0.97]";

/** The default bordered button: menus, dialogs, toolbars. Height, side padding
 * and type size are NOT here: `cn` does not merge, so they live only in the
 * size recipes (`CONTROL_BUTTON_SIZE`) and a caller picks one. */
export const CONTROL_BUTTON =
  "inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 " +
  "rounded-md border border-border-control bg-control pt-px text-fg-control " +
  "transition-[color,background-color,border-color,scale] duration-[120ms] hover:bg-control-hover " +
  "disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-control " +
  PRESSED +
  " " +
  FOCUS_RING;

export const CONTROL_BUTTON_SIZE = {
  sm: "min-h-control-sm px-2 text-sm",
  md: "min-h-control-md px-3 text-base",
  lg: "min-h-control-lg px-3 text-base",
} as const;

/** Chrome-neutral: the icon renders in theme colors with no box of its own. */
export const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 " +
  "text-fg-secondary transition-[color,background-color,scale] duration-[120ms] " +
  "hover:not-disabled:bg-surface-hover hover:not-disabled:text-fg-strong " +
  "disabled:cursor-default disabled:text-fg-disabled " +
  PRESSED +
  " " +
  FOCUS_RING;

/** A menu trigger with no box of its own: label plus chevron, the ghost hover
 * of an icon button, the small control height. */
export const GHOST_TRIGGER =
  "inline-flex min-h-control-sm min-w-0 items-center gap-1 rounded-md border-0 bg-transparent px-1.5 " +
  "text-sm text-fg-secondary transition-[color,background-color,scale] duration-[120ms] " +
  "hover:not-disabled:bg-surface-hover hover:not-disabled:text-fg-strong " +
  "disabled:cursor-default disabled:text-fg-disabled " +
  PRESSED +
  " " +
  FOCUS_RING;

/** Text that behaves like a button. */
export const LINK_BUTTON =
  "inline min-h-0 border-0 bg-transparent p-0 text-left underline-offset-2 " +
  "hover:not-disabled:underline active:not-disabled:opacity-70 " +
  "disabled:cursor-default disabled:text-fg-disabled " +
  FOCUS_RING;

/** Floating chrome: menus, select popups, popovers. */
export const POPOVER_SURFACE =
  "flex min-w-0 flex-col rounded-lg border border-border-divider bg-surface-popover " +
  "p-1 text-fg-primary shadow-popover origin-(--transform-origin) outline-none";

export const CONTEXT_MENU_SURFACE =
  "flex min-w-0 flex-col rounded-lg border border-border-default bg-surface-context-menu " +
  "p-1 text-fg-primary shadow-context-menu origin-(--transform-origin)";

/** One selectable row inside any of the surfaces above. */
export const MENU_ITEM =
  "flex w-full min-w-0 cursor-pointer select-none items-center justify-start gap-2 " +
  "rounded-md border border-transparent px-2.5 py-1 text-left text-base text-fg-primary " +
  "data-highlighted:bg-surface-popover-item-hover data-[selected]:text-fg-strong active:brightness-90 " +
  "data-disabled:cursor-default data-disabled:text-fg-disabled " +
  FOCUS_RING;

export const MENU_SEPARATOR = "my-1 h-px shrink-0 bg-border-divider";

/** Text inputs and textareas. */
export const FORM_FIELD =
  "min-w-0 rounded-md border border-border-control bg-surface-field px-2.5 text-base " +
  "text-fg-primary placeholder:text-fg-placeholder " +
  "focus:border-focus-ring focus:shadow-[inset_0_0_0_1px_var(--focus-ring)] focus:outline-none " +
  "disabled:text-fg-disabled";

export const INPUT_FIELD = `${FORM_FIELD} min-h-control-md`;

export const SHORTCUT_HINT = "whitespace-nowrap text-xs leading-none text-fg-muted";

/** Model, time, Follow/Bookmark, word count. Nested buttons otherwise snap to
 * `--fs-base` from the global form rule in `app.css`. */
export const METADATA_LINE =
  "text-[length:calc(var(--fs-base)-1px)] " +
  "[&_a]:text-[length:inherit] [&_button]:text-[length:inherit]";

/** Feed event line and highlight provenance: one step below `METADATA_LINE`. */
export const METADATA_LINE_COMPACT =
  "text-[length:calc(var(--fs-xs)-1px)] " +
  "[&_a]:text-[length:inherit] [&_button]:text-[length:inherit]";

export const DIALOG_BACKDROP = "fixed inset-0 bg-surface-scrim";

export const DIALOG_POPUP =
  "fixed top-1/2 left-1/2 z-(--z-dialog) w-[min(440px,calc(100vw-32px))] -translate-x-1/2 " +
  "-translate-y-1/2 rounded-lg border border-border-dialog bg-surface-panel p-5 " +
  "text-fg-primary shadow-dialog";
