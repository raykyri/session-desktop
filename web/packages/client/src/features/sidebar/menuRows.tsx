// The menu-row helper the sidebar, the workspace switcher and the journal
// cards share.
//
// The thread rows themselves come from `features/research/treeMenu.tsx`, which
// the research document view owns; what is left here is the leading-glyph row,
// because a journal entry's menu is not a thread menu and has no home over
// there.
//
// There is no keycap helper any more: these rows sit on Base UI menus, whose
// only key behaviour is typeahead, so a single-letter badge advertised a key
// that moved the highlight instead of acting.

import type { ReactNode } from "react";

import { MenuItem } from "../../ui/Menu.js";

/** A menu row with a leading glyph. `MenuItem` truncates its children, so the
 * icon and the label share one flex line inside that clamp rather than each
 * wrapping on their own. */
export function IconMenuItem({
  icon,
  label,
  title,
  tone,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string | undefined;
  tone?: "default" | "danger";
  disabled?: boolean | undefined;
  onClick: () => void;
}) {
  return (
    <MenuItem
      onClick={onClick}
      {...(disabled === undefined ? {} : { disabled })}
      {...(tone === undefined ? {} : { tone })}
    >
      <span className="flex min-w-0 items-center gap-2" title={title}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </MenuItem>
  );
}
