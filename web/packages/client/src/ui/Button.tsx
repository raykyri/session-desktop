import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "../lib/cn.js";

import { CONTROL_BUTTON, ICON_BUTTON, LINK_BUTTON } from "./surfaces.js";

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export interface ControlButtonProps extends NativeButtonProps {
  ref?: Ref<HTMLButtonElement>;
  /** `danger` is the only tone that changes the box; everything else is a
   * caller-supplied `className`. */
  tone?: "default" | "danger";
  /** Renders the button at the small control height (inline and table actions). */
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASS = {
  sm: "min-h-control-sm px-2 text-sm",
  md: "min-h-control-md",
  lg: "min-h-control-lg",
} as const;

const DANGER_CLASS =
  "border-danger-border bg-danger-bg text-danger-strong hover:bg-danger-bg-hover";

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
}

export function IconButton({
  ref,
  label,
  className,
  type = "button",
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      className={cn(ICON_BUTTON, "size-control-sm", className)}
    >
      {children}
    </button>
  );
}

export interface LinkButtonProps extends NativeButtonProps {
  ref?: Ref<HTMLButtonElement>;
}

export function LinkButton({ ref, className, type = "button", ...props }: LinkButtonProps) {
  return <button {...props} ref={ref} type={type} className={cn(LINK_BUTTON, className)} />;
}
