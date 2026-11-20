// A member's avatar as the members mockup draws it (`av`): initials on one of
// six fills (`--avatar-1`…`--avatar-6`, 02 §11), 28 px, 20 px (`sm`) or
// 16 px (`xs`). Channel glyphs use the same fills (`ChannelGlyph`).

import { cn } from "../lib/cn.js";

/** Static class names, so Tailwind generates every fill. */
const FILLS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
] as const;

/** A fill index 1..6 for a handle or channel name; the same name always gets
 * the same fill. */
export function fillIndex(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return (hash % FILLS.length) + 1;
}

/** The mock's `initials`: the first letters of the first two parts of a
 * handle split at `.` or `_`, otherwise its first two letters. */
export function initialsOf(handle: string): string {
  const parts = handle.split(/[._]/).filter(Boolean);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  const letters =
    parts.length > 1 ? `${first.slice(0, 1)}${second.slice(0, 1)}` : handle.slice(0, 2);
  return letters.toUpperCase();
}

const SIZE = {
  md: "size-7 text-[10.5px] pt-px",
  sm: "size-5 text-[8.5px] pt-px",
  xs: "size-4 text-[7.5px]",
} as const;

export interface AvatarProps {
  handle: string;
  size?: keyof typeof SIZE;
  className?: string;
}

/** Decorative: the name it stands for is always in a label or text nearby. */
export function Avatar({ handle, size = "md", className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "text-avatar-fg inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-[0.02em]",
        FILLS[fillIndex(handle) - 1],
        SIZE[size],
        className,
      )}
    >
      {initialsOf(handle)}
    </span>
  );
}

/** A channel's glyph: its first letter on a fill (`glyph`). */
export function ChannelGlyph({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "text-avatar-fg inline-grid size-4 shrink-0 place-items-center rounded-sm text-[9px] font-bold",
        FILLS[fillIndex(name) - 1],
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
