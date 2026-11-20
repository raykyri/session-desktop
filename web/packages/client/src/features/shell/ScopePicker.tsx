// The scope picker (02 §2.2 item 2; `headerSpaces`, `SCOPES`, `SCOPE_IC`): a
// menu button whose radio items choose which channels the strip lists. With
// one scope (signed out) no picker is drawn.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";

import type { ChannelScope } from "../../stores/navigation.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { CheckCircleIcon, CheckIcon, ChevronDownIcon, CompassIcon, PersonIcon } from "./icons.js";
import { SHELL_MENU_ITEM, SHELL_MENU_POPUP } from "./menuStyles.js";

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

export interface ScopePickerProps {
  scopes: readonly ChannelScope[];
  scope: ChannelScope;
  onScopeChange: (scope: ChannelScope) => void;
  onOpenChange?: (open: boolean) => void;
}

export function ScopePicker({ scopes, scope, onScopeChange, onOpenChange }: ScopePickerProps) {
  if (scopes.length < 2) return null;
  return (
    <BaseMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <BaseMenu.Trigger
        className={
          "bg-control text-fg-heading inline-flex h-7 shrink-0 items-center gap-[5px] rounded-[14px] px-2.5 text-sm font-semibold " +
          FOCUS_RING
        }
      >
        {SCOPE_LABEL[scope]}
        <ChevronDownIcon size={11} className="text-fg-muted" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="bottom" align="start" sideOffset={6} className="z-(--z-popover)">
          <BaseMenu.Popup className={SHELL_MENU_POPUP}>
            <BaseMenu.RadioGroup
              value={scope}
              onValueChange={(value: unknown) => onScopeChange(value as ChannelScope)}
            >
              {scopes.map((item) => (
                <BaseMenu.RadioItem key={item} value={item} className={SHELL_MENU_ITEM}>
                  <span className="text-accent inline-flex">{SCOPE_ICON[item]}</span>
                  <span className="flex-1">{SCOPE_LABEL[item]}</span>
                  <BaseMenu.RadioItemIndicator className="text-accent inline-flex">
                    <CheckIcon size={13} />
                  </BaseMenu.RadioItemIndicator>
                </BaseMenu.RadioItem>
              ))}
            </BaseMenu.RadioGroup>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
