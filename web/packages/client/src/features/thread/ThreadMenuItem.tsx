// One row of a thread page menu: an icon, a label, an optional shortcut key
// shown at the right, the current mark, and danger styling. A row with a
// `shortcut` is also chosen by pressing that key while the menu is open
// (`ThreadMenu` handles the key).

import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { MENU_ITEM, MENU_ITEM_SIZE } from "../../ui/surfaces.js";

export function ThreadMenuItem({
  icon,
  label,
  shortcut,
  disabled = false,
  danger = false,
  current = false,
  title,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  current?: boolean;
  title?: string | undefined;
  onSelect: () => void;
}) {
  return (
    <BaseMenu.Item
      disabled={disabled}
      title={title}
      data-shortcut={shortcut ? shortcut.toLowerCase() : undefined}
      onClick={() => onSelect()}
      className={cn(
        MENU_ITEM,
        MENU_ITEM_SIZE.md,
        "whitespace-nowrap",
        danger && "text-danger-muted",
      )}
    >
      <span className="text-fg-muted inline-flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {current ? <Check size={13} className="text-fg-muted shrink-0" aria-label="Open" /> : null}
      {shortcut ? (
        <kbd className="text-fg-muted ml-3 shrink-0 font-[inherit] text-xs" aria-hidden="true">
          {shortcut}
        </kbd>
      ) : null}
    </BaseMenu.Item>
  );
}

export function ThreadMenuSeparator() {
  return <BaseMenu.Separator className="bg-border-divider my-1 h-px shrink-0" />;
}

/** A line of details at the top of a menu. */
export function ThreadMenuMeta({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="text-fg-muted px-2.5 py-1 text-xs" title={title}>
      {children}
    </div>
  );
}
