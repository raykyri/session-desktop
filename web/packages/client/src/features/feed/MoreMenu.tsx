// The "…" menu of a thread, branch or reply (`moreMenu`, label "More"): the
// item's own actions, then Delete, or Delete disabled with the reason
// (02 §3.2, §4.2, §4.3). Focus starts on the first enabled item and returns
// to the button (02 §10.1).

import { Menu } from "@base-ui/react/menu";

import { cn } from "../../lib/cn.js";
import { SHELL_MENU_ITEM, SHELL_MENU_POPUP } from "../shell/menuStyles.js";

import { DotsIcon } from "./icons.js";

export interface MoreAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Shown under the label of a disabled item. */
  disabledReason?: string | undefined;
}

/** `inDialog`: the menu opens over a feed dialog (z 40-43, `spaces.css`), as
 * the member list's does. */
export function MoreMenu({
  actions,
  inDialog = false,
}: {
  actions: readonly MoreAction[];
  inDialog?: boolean;
}) {
  if (actions.length === 0) return null;
  return (
    <span className="more inline-flex">
      <Menu.Root>
        <Menu.Trigger className="more-btn" aria-label="More">
          <DotsIcon />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side="bottom"
            align="end"
            sideOffset={6}
            className={inDialog ? "z-[44]" : "z-(--z-popover)"}
          >
            <Menu.Popup className={`${SHELL_MENU_POPUP} fpop-menu`}>
              {actions.map((action) =>
                action.disabledReason !== undefined ? (
                  <Menu.Item
                    key={action.label}
                    disabled
                    className="mi-off flex cursor-default rounded-md px-2.5 py-[7px] text-sm whitespace-nowrap"
                  >
                    <span>
                      {action.label}
                      <small>{action.disabledReason}</small>
                    </span>
                  </Menu.Item>
                ) : (
                  <Menu.Item
                    key={action.label}
                    onClick={action.onSelect}
                    className={cn(SHELL_MENU_ITEM, action.danger && "text-status-attention")}
                  >
                    <span className="flex-1">{action.label}</span>
                  </Menu.Item>
                ),
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
