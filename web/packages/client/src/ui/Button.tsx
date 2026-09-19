import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "../lib/cn.js";

import { Tooltip } from "./Tooltip.js";
import { CONTROL_BUTTON, CONTROL_BUTTON_SIZE, ICON_BUTTON, LINK_BUTTON } from "./surfaces.js";

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export interface ControlButtonProps extends NativeButtonProps {
  ref?: Ref<HTMLButtonElement>;
  /** `danger` is the only tone that changes the box; everything else is a
   * caller-supplied `className`. */
  tone?: "default" | "danger";
  /** Renders the button at the small control height (inline and table actions). */
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASS = CONTROL_BUTTON_SIZE;

const DANGER_CLASS =
  "border-danger-border bg-danger-bg text-danger-strong hover:not-disabled:bg-danger-bg-hover " +
  "disabled:border-border-control disabled:bg-control";

export function ControlButton({
  ref,
  tone = "default",
  size = "md",
  className,
  type = "button",
  ...props
}: ControlButtonProps) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn(CONTROL_BUTTON, SIZE_CLASS[size], tone === "danger" && DANGER_CLASS, className)}
    />
  );
}

export interface IconButtonProps extends NativeButtonProps {
  ref?: Ref<HTMLButtonElement>;
  /** Icon buttons carry no text, so a label is required rather than optional
   * (08 §7). */
  label: string;
  children: ReactNode;
  /** When false, the label is aria-only. Overflow menus that already name
   * the popup skip the hover tip. */
  tooltip?: boolean;
}

export function IconButton({
  ref,
  label,
  className,
  type = "button",
  children,
  tooltip = true,
  ...props
}: IconButtonProps) {
  // The label doubles as the tooltip, shown on hover and on keyboard focus
  // alike; `title` is left to callers that need overflow text.
  const button = (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(ICON_BUTTON, "size-control-sm", className)}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  return <Tooltip content={props.title ?? label}>{button}</Tooltip>;
}

export interface LinkButtonProps extends NativeButtonProps {
  ref?: Ref<HTMLButtonElement>;
}

export function LinkButton({ ref, className, type = "button", ...props }: LinkButtonProps) {
  return <button {...props} ref={ref} type={type} className={cn(LINK_BUTTON, className)} />;
}
