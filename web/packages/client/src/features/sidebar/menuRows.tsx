// The menu row with a leading icon that the workspace switcher, the sidebar's
// folder menu and Home's card menus share.
//
// There is no keycap helper: these rows sit on Base UI menus, whose only key
// behaviour is typeahead, so a single-letter badge would advertise a key that
// moves the highlight instead of acting.

import type { ReactNode } from "react";

import { MenuItem, type MenuItemProps } from "../../ui/Menu.js";

/** A menu row with a leading glyph. `MenuItem` truncates its children, so the
 * icon and the label share one flex line inside that clamp rather than each
 * wrapping on their own. The label is `label` or `children`. */
export function IconMenuItem({
  icon,
  label,
  title,
  children,
  ...props
}: {
  icon: ReactNode;
  label?: string;
  title?: string | undefined;
  children?: ReactNode;
} & Omit<MenuItemProps, "children">) {
  return (
    <MenuItem {...props}>
      <span className="flex min-w-0 items-center gap-2" title={title}>
        <span className="text-fg-muted inline-flex shrink-0">{icon}</span>
        <span className="truncate">{label ?? children}</span>
      </span>
    </MenuItem>
  );
}
