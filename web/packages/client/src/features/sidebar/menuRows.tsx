// The two menu-row helpers the sidebar and the journal cards share.
//
// The thread rows themselves come from `features/research/treeMenu.tsx`, which
// the research document view owns; what is left here is the leading-glyph row
// and the single-letter keycap the desktop's context menus used, because a
// journal entry's menu is not a thread menu and has no home over there.

import type { ReactNode } from "react";

import { MenuItem } from "../../ui/Menu.js";

/** A single-letter keycap, the way the desktop's context menus labelled the
 * two destructive actions. */
export function MenuKeycap({ children }: { children: string }) {
  return (
    <kbd className="border-border-divider bg-surface-fill-subtle text-fg-subtle rounded border px-1 font-mono text-xs">
      {children}
    </kbd>
  );
}

/** A menu row with a leading glyph. `MenuItem` truncates its children, so the
 * icon and the label share one flex line inside that clamp rather than each
 * wrapping on their own. */
export function IconMenuItem({
  icon,
  label,
  title,
  hint,
  tone,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string | undefined;
  hint?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean | undefined;
  onClick: () => void;
}) {
  return (
    <MenuItem
      onClick={onClick}
      {...(disabled === undefined ? {} : { disabled })}
      {...(tone === undefined ? {} : { tone })}
      {...(hint === undefined ? {} : { hint })}
    >
      <span className="flex min-w-0 items-center gap-2" title={title}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </MenuItem>
  );
}
