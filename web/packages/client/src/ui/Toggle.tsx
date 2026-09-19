import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Check } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { FOCUS_RING } from "./surfaces.js";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  /** Explanatory line under the label, as the settings rows use. */
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** A settings toggle (08 §4): label, optional description, switch. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: SwitchProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4 py-2", className)}>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="text-fg-primary block text-base">{label}</span>
        {description ? (
          <span className="text-fg-muted mt-0.5 block text-sm">{description}</span>
        ) : null}
      </label>
      <BaseSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        className={cn(
          "border-border-control relative h-5 w-9 shrink-0 cursor-pointer rounded-full border",
          "bg-control transition-colors duration-[120ms]",
          "data-checked:border-accent-strong data-checked:bg-accent-strong",
          "data-disabled:cursor-default data-disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        <BaseSwitch.Thumb
          className={cn(
            "bg-surface-popover block size-3.5 translate-x-0.5 rounded-full",
            "transition-transform duration-[120ms] data-checked:translate-x-4",
          )}
        />
      </BaseSwitch.Root>
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  /** Explanatory line under the label, in the same click target. */
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <BaseCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        className={cn(
          "mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm",
          "border-border-control bg-control text-fg-on-accent border",
          "data-checked:border-accent-strong data-checked:bg-accent-strong",
          "data-disabled:cursor-default data-disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        <BaseCheckbox.Indicator>
          <Check size={11} strokeWidth={3} aria-hidden="true" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="text-fg-primary block text-base">{label}</span>
        {description ? (
          <span className="text-fg-muted mt-0.5 block text-sm">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
