// The account menu (02 §2.2 item 7): the 20 px avatar button, with a 9 px
// dot while any notification is unread (W2.6). The menu's header shows the
// avatar, name and "@handle · Member" ("· Admin", "· No invite yet"); a
// member gets Notifications (with the unread count), Invites, Saved, Usage
// and API keys, Site Admin (site admins only) and Sign out; an account
// without an invite gets Enter an invite code and Sign out. There is no
// Settings entry (decision P23).

import { Menu as BaseMenu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";

import { Avatar } from "../../ui/Avatar.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { ChevronDownIcon } from "./icons.js";
import { SHELL_MENU_ITEM, SHELL_MENU_POPUP, SHELL_MENU_SEPARATOR } from "./menuStyles.js";
import { accountLine, type Viewer } from "./viewer.js";

export function accountButtonLabel(unread: number): string {
  if (unread === 0) return "Account";
  return `Account, ${unread} unread notification${unread === 1 ? "" : "s"}`;
}

export interface AccountMenuProps {
  viewer: Exclude<Viewer, { kind: "signedOut" }>;
  unreadCount: number;
  onSignOut: () => void;
  onOpenChange?: (open: boolean) => void;
}

export function AccountMenu({ viewer, unreadCount, onSignOut, onOpenChange }: AccountMenuProps) {
  const navigate = useNavigate();
  const handle = viewer.user.login;
  const go = (to: "/notifications" | "/invites" | "/saved" | "/usage" | "/admin" | "/welcome") =>
    void navigate({ to });

  return (
    <BaseMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <BaseMenu.Trigger
        aria-label={accountButtonLabel(unreadCount)}
        className={
          "text-fg-muted hover:bg-surface-fill-hover data-[popup-open]:bg-surface-fill-hover relative inline-flex h-[30px] shrink-0 items-center gap-1 rounded-[15px] pr-1.5 pl-1 " +
          FOCUS_RING
        }
      >
        <Avatar handle={handle} size="sm" />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            data-unread-dot=""
            className="bg-unread-dot absolute top-[3px] left-5 size-[9px] rounded-full shadow-[0_0_0_2px_var(--chrome-header-bg)]"
          />
        ) : null}
        <ChevronDownIcon size={12} />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="bottom" align="end" sideOffset={6} className="z-(--z-popover)">
          <BaseMenu.Popup className={SHELL_MENU_POPUP}>
            <div className="flex items-center gap-2.5 px-2.5 pt-2 pb-1.5">
              <Avatar handle={handle} />
              <div>
                <b className="text-fg-heading block text-sm">{viewer.user.name ?? handle}</b>
                <small className="text-fg-faint -mt-0.5 block text-xs">{accountLine(viewer)}</small>
              </div>
            </div>
            <BaseMenu.Separator className={SHELL_MENU_SEPARATOR} />
            {viewer.kind === "member" ? (
              <>
                <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/notifications")}>
                  <span className="flex-1">Notifications</span>
                  {unreadCount > 0 ? (
                    <b className="bg-accent-strong text-fg-on-accent ml-3 inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[9px] px-[5px] text-[10.5px] font-bold">
                      {unreadCount}
                    </b>
                  ) : null}
                </BaseMenu.Item>
                <BaseMenu.Separator className={SHELL_MENU_SEPARATOR} />
                <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/invites")}>
                  Invites
                </BaseMenu.Item>
                <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/saved")}>
                  Saved
                </BaseMenu.Item>
                <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/usage")}>
                  Usage and API keys
                </BaseMenu.Item>
                {viewer.isAdmin ? (
                  <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/admin")}>
                    Site Admin
                  </BaseMenu.Item>
                ) : null}
              </>
            ) : (
              <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => go("/welcome")}>
                Enter an invite code
              </BaseMenu.Item>
            )}
            <BaseMenu.Separator className={SHELL_MENU_SEPARATOR} />
            <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={onSignOut}>
              Sign out
            </BaseMenu.Item>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
