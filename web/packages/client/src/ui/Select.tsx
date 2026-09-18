import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Fragment } from "react";

import { cn } from "../lib/cn.js";

import { CONTROL_BUTTON, MENU_ITEM, MENU_SEPARATOR, POPOVER_SURFACE } from "./surfaces.js";

export interface SelectOption {
  value: string;
  label: string;
  /** Right-aligned detail on the row. */
  detail?: string | undefined;
  disabled?: boolean | undefined;
  /** Draws a separator above this row. */
  dividerBefore?: boolean | undefined;
  tone?: "default" | "danger";
  iconSrc?: string | undefined;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

function optionRowClass(option: SelectOption): string {
  return cn(MENU_ITEM, option.tone === "danger" && "text-danger-muted");
}

function OptionContent({ option, selected }: { option: SelectOption; selected: boolean }) {
  return (
    <>
      {option.iconSrc ? (
        <img className="size-3.5 shrink-0" src={option.iconSrc} alt="" aria-hidden="true" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.detail ? (
        <span className="text-fg-subtle shrink-0 text-xs">{option.detail}</span>
      ) : null}
      <span className="ml-1 w-3.5 shrink-0">
        {selected ? <Check size={14} aria-hidden="true" /> : null}
      </span>
    </>
  );
}

/**
 * A listbox styled like the app's controls (08 §4). A native `<select>` cannot
 * tint one option, show a detail column, or carry an icon, all of which the
 * model and folder pickers need.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
  placeholder,
}: SelectProps) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(CONTROL_BUTTON, "justify-between gap-2 px-2.5", className)}
      >
        <BaseSelect.Value className="min-w-0 truncate" placeholder={placeholder} />
        <BaseSelect.Icon className="text-fg-subtle shrink-0">
          <ChevronDown size={13} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          alignItemWithTrigger={false}
          sideOffset={6}
          className="z-(--z-select-popover)"
        >
          <BaseSelect.Popup className={cn(POPOVER_SURFACE, "min-w-(--anchor-width)")}>
            <BaseSelect.List>
              {options.map((option) => (
                // A plain wrapper element would sit between the listbox and
                // its options as a `generic` node and break the ARIA ownership
                // the roles promise, so the divider is a sibling instead.
                <Fragment key={option.value}>
                  {option.dividerBefore ? (
                    <div className={MENU_SEPARATOR} role="separator" />
                  ) : null}
                  <BaseSelect.Item
                    value={option.value}
                    disabled={option.disabled ?? false}
                    className={optionRowClass(option)}
                  >
                    {option.iconSrc ? (
                      <img
                        className="size-3.5 shrink-0"
                        src={option.iconSrc}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : null}
                    <BaseSelect.ItemText className="min-w-0 flex-1 truncate">
                      {option.label}
                    </BaseSelect.ItemText>
                    {option.detail ? (
                      <span className="text-fg-subtle shrink-0 text-xs">{option.detail}</span>
                    ) : null}
                    <BaseSelect.ItemIndicator className="ml-1 shrink-0">
                      <Check size={14} aria-hidden="true" />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                </Fragment>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export interface LauncherSelectSubmenu {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

export interface LauncherSelectProps extends Omit<SelectProps, "placeholder"> {
  /** A secondary choice shown as one row below a separator at the bottom of
   * the popup, opening its own list beside it. */
  submenu?: LauncherSelectSubmenu | undefined;
}

/**
 * The composer's model chooser, ported from the desktop `LauncherSelect.tsx`.
 *
 * Deviation from 08 §4, which specified `Select` with a `render`ed submenu row:
 * Base UI's Select is a flat listbox with no part for a row that opens its own
 * list, and nesting a second `Select.Root` inside the popup nests two portals
 * and two focus scopes. `Menu` has `SubmenuRoot`/`SubmenuTrigger` built for
 * exactly this shape, so the primary options render as a `RadioGroup` (one
 * checked row, `menuitemradio` semantics) and the secondary choice as a
 * submenu. The library then owns the ArrowRight-opens / ArrowLeft-closes
 * behavior the desktop hand-rolled with `submenuAnchor` measurement.
 */
export function LauncherSelect({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
  submenu,
}: LauncherSelectProps) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  const submenuSelected =
    submenu?.options.find((option) => option.value === submenu.value) ?? submenu?.options[0];

  return (
    <BaseMenu.Root>
      {/* A menu trigger is a plain button, so its accessible name is all a
          screen reader gets — and `aria-label` overrides the visible text.
          Naming it with the label alone would announce "Launch model" and
          never the model. (`Select`'s trigger is a combobox and takes its
          value from the listbox's selected option, so it needs no such
          treatment.) */}
      <BaseMenu.Trigger
        aria-label={selected ? `${label}: ${selected.label}` : label}
        disabled={disabled}
        className={cn(
          CONTROL_BUTTON,
          "justify-between gap-2 px-2.5",
          selected?.tone === "danger" && "text-danger-muted",
          className,
        )}
      >
        {selected?.iconSrc ? (
          <img className="size-3.5 shrink-0" src={selected.iconSrc} alt="" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 truncate">{selected?.label}</span>
        <ChevronDown size={13} className="text-fg-subtle shrink-0" aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-(--z-select-popover)"
        >
          <BaseMenu.Popup className={cn(POPOVER_SURFACE, "min-w-(--anchor-width)")}>
            <BaseMenu.RadioGroup
              value={value}
              onValueChange={(next: string) => onChange(next)}
              aria-label={label}
            >
              {options.map((option) => (
                <Fragment key={option.value}>
                  {option.dividerBefore ? (
                    <div className={MENU_SEPARATOR} role="separator" />
                  ) : null}
                  <BaseMenu.RadioItem
                    value={option.value}
                    disabled={option.disabled ?? false}
                    closeOnClick
                    className={optionRowClass(option)}
                  >
                    <OptionContent option={option} selected={option.value === value} />
                  </BaseMenu.RadioItem>
                </Fragment>
              ))}
            </BaseMenu.RadioGroup>
            {submenu ? (
              <>
                <div className={MENU_SEPARATOR} role="separator" />
                <BaseMenu.SubmenuRoot>
                  <BaseMenu.SubmenuTrigger className={MENU_ITEM}>
                    <span className="min-w-0 flex-1 truncate">{submenu.label}</span>
                    <span className="text-fg-subtle shrink-0 text-xs">
                      {submenuSelected?.label}
                    </span>
                    <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
                  </BaseMenu.SubmenuTrigger>
                  <BaseMenu.Portal>
                    <BaseMenu.Positioner
                      side="right"
                      align="start"
                      sideOffset={4}
                      className="z-(--z-select-popover)"
                    >
                      <BaseMenu.Popup className={cn(POPOVER_SURFACE, "min-w-44")}>
                        <BaseMenu.RadioGroup
                          value={submenu.value}
                          onValueChange={(next: string) => submenu.onChange(next)}
                          aria-label={submenu.ariaLabel ?? submenu.label}
                        >
                          {submenu.options.map((option) => (
                            <BaseMenu.RadioItem
                              key={option.value}
                              value={option.value}
                              disabled={option.disabled ?? false}
                              closeOnClick
                              className={optionRowClass(option)}
                            >
                              <OptionContent
                                option={option}
                                selected={option.value === submenu.value}
                              />
                            </BaseMenu.RadioItem>
                          ))}
                        </BaseMenu.RadioGroup>
                      </BaseMenu.Popup>
                    </BaseMenu.Positioner>
                  </BaseMenu.Portal>
                </BaseMenu.SubmenuRoot>
              </>
            ) : null}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
