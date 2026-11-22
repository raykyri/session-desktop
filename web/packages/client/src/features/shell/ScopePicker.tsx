// The scope picker (02 §2.2 item 2; `headerSpaces`, `SCOPES`, `SCOPE_IC`): a
// menu button whose radio items choose which channels the strip lists. With
// one scope (signed out) no picker is drawn above the phone width.
//
// At 520 px and below the strip is not shown and the picker takes its place
// (02 W2.5): the button names the open channel (else the scope), and the
// menu lists, below the scopes, the scope's channels in the strip's order as
// radio items, the scope's empty line when it has none, and New channel for
// writers. The picker is drawn there with one scope too.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import type { ChannelScope } from "../../stores/navigation.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { emptyStripLine } from "./ChannelStrip.js";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CompassIcon,
  PersonIcon,
  PlusIcon,
} from "./icons.js";
import { SHELL_MENU_ITEM, SHELL_MENU_POPUP, SHELL_MENU_SEPARATOR } from "./menuStyles.js";
import type { ShellChannel } from "./shellData.js";

export const SCOPE_LABEL: Record<ChannelScope, string> = {
  joined: "Joined",
  yours: "Channels you manage",
  all: "All",
};

const SCOPE_ICON: Record<ChannelScope, ReactNode> = {
  joined: <CheckCircleIcon size={13} />,
  yours: <PersonIcon size={13} />,
  all: <CompassIcon size={13} />,
};

/** The strip's contents, for the menu at the phone width. */
export interface FoldedStrip {
  /** Null while the replica loads them: no rows and no empty line. */
  channels: readonly ShellChannel[] | null;
  /** The channel whose feed is open, without `#`. */
  current: string | null;
  /** True for accounts that can write: New channel. */
  canWrite: boolean;
  onNewChannel?: (() => void) | undefined;
}

export interface ScopePickerProps {
  scopes: readonly ChannelScope[];
  scope: ChannelScope;
  onScopeChange: (scope: ChannelScope) => void;
  onOpenChange?: (open: boolean) => void;
  /** Set at the phone width: the menu carries the strip. */
  fold?: FoldedStrip | null;
}

export function ScopePicker({
  scopes,
  scope,
  onScopeChange,
  onOpenChange,
  fold = null,
}: ScopePickerProps) {
  const navigate = useNavigate();
  if (scopes.length < 2 && !fold) return null;
  const label = fold?.current ? `#${fold.current}` : SCOPE_LABEL[scope];
  return (
    <BaseMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <BaseMenu.Trigger
        className={cn(
          "bg-control text-fg-heading inline-flex h-7 max-w-full min-w-0 shrink-0 items-center gap-[5px] rounded-[14px] px-2.5 text-sm font-semibold",
          FOCUS_RING,
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon size={11} className="text-fg-muted" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="bottom" align="start" sideOffset={6} className="z-(--z-popover)">
          <BaseMenu.Popup
            className={cn(
              SHELL_MENU_POPUP,
              fold && "max-h-[min(460px,62vh)] max-w-[calc(100vw-32px)] overflow-y-auto",
            )}
          >
            <BaseMenu.RadioGroup
              value={scope}
              onValueChange={(value: unknown) => onScopeChange(value as ChannelScope)}
            >
              {scopes.map((item) => (
                <BaseMenu.RadioItem
                  closeOnClick
                  key={item}
                  value={item}
                  className={SHELL_MENU_ITEM}
                >
                  <span className="text-accent inline-flex">{SCOPE_ICON[item]}</span>
                  <span className="flex-1">{SCOPE_LABEL[item]}</span>
                  <BaseMenu.RadioItemIndicator className="text-accent inline-flex">
                    <CheckIcon size={13} />
                  </BaseMenu.RadioItemIndicator>
                </BaseMenu.RadioItem>
              ))}
            </BaseMenu.RadioGroup>
            {fold ? <FoldedChannels fold={fold} scope={scope} navigate={navigate} /> : null}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

function FoldedChannels({
  fold,
  scope,
  navigate,
}: {
  fold: FoldedStrip;
  scope: ChannelScope;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { channels, current, canWrite, onNewChannel } = fold;
  return (
    <>
      {channels !== null ? (
        <>
          <BaseMenu.Separator className={SHELL_MENU_SEPARATOR} />
          {channels.length > 0 ? (
            <BaseMenu.RadioGroup
              value={current ?? ""}
              onValueChange={(name: unknown) =>
                void navigate({ to: "/c/$name", params: { name: name as string }, search: {} })
              }
            >
              {channels.map((channel) => (
                <BaseMenu.RadioItem
                  closeOnClick
                  key={channel.id}
                  value={channel.name}
                  label={channel.name}
                  className={SHELL_MENU_ITEM}
                >
                  <span className="min-w-0 flex-1 truncate">#{channel.name}</span>
                  <BaseMenu.RadioItemIndicator className="text-accent inline-flex">
                    <CheckIcon size={13} />
                  </BaseMenu.RadioItemIndicator>
                </BaseMenu.RadioItem>
              ))}
            </BaseMenu.RadioGroup>
          ) : (
            <div className="text-fg-faint px-2.5 py-1.5 text-sm">{emptyStripLine(scope)}</div>
          )}
        </>
      ) : null}
      {canWrite ? (
        <>
          <BaseMenu.Separator className={SHELL_MENU_SEPARATOR} />
          <BaseMenu.Item className={SHELL_MENU_ITEM} onClick={() => onNewChannel?.()}>
            <span className="text-accent inline-flex">
              <PlusIcon size={13} />
            </span>
            <span className="flex-1">New channel</span>
          </BaseMenu.Item>
        </>
      ) : null}
    </>
  );
}
