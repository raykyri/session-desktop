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

/** The default bordered button: menus, dialogs, toolbars. */
export const CONTROL_BUTTON =
  "inline-flex min-h-control-md flex-wrap items-center justify-center gap-x-2 gap-y-0.5 " +
  "rounded-md border border-border-control bg-control px-3 pt-px text-base text-fg-control " +
  "transition-colors duration-[120ms] hover:bg-control-hover " +
  "disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-control " +
  FOCUS_RING;

/** Chrome-neutral: the icon renders in theme colors with no box of its own. */
export const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 " +
  "text-fg-secondary transition-colors duration-[120ms] " +
  "hover:not-disabled:bg-surface-hover hover:not-disabled:text-fg-strong " +
  "disabled:cursor-default disabled:text-fg-disabled " +
  FOCUS_RING;

/** Text that behaves like a button. */
export const LINK_BUTTON =
  "inline min-h-0 border-0 bg-transparent p-0 text-left underline-offset-2 " +
  "hover:underline disabled:cursor-default disabled:text-fg-disabled " +
  FOCUS_RING;

/** Floating chrome: menus, select popups, popovers. */
export const POPOVER_SURFACE =
  "flex min-w-0 flex-col rounded-lg border border-border-divider bg-surface-popover " +
  "p-1 text-fg-primary shadow-popover origin-(--transform-origin)";

export const CONTEXT_MENU_SURFACE =
  "flex min-w-0 flex-col rounded-lg border border-border-default bg-surface-context-menu " +
  "p-1 text-fg-primary shadow-context-menu origin-(--transform-origin)";

/** One selectable row inside any of the surfaces above. */
export const MENU_ITEM =
  "flex w-full min-w-0 cursor-pointer select-none items-center justify-start gap-2 " +
  "rounded-md border border-transparent px-2.5 py-1 text-left text-base text-fg-primary " +
  "data-highlighted:bg-surface-popover-item-hover data-[selected]:text-fg-strong " +
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

export const SHORTCUT_HINT = "whitespace-nowrap text-xs leading-none text-fg-disabled";

export const DIALOG_BACKDROP = "fixed inset-0 bg-surface-scrim";

export const DIALOG_POPUP =
  "fixed top-1/2 left-1/2 z-(--z-dialog) w-[min(440px,calc(100vw-32px))] -translate-x-1/2 " +
  "-translate-y-1/2 rounded-lg border border-border-dialog bg-surface-panel p-5 " +
  "text-fg-primary shadow-dialog";
