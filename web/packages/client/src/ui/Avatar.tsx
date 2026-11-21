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
  /** null: a deleted account, drawn as an empty neutral circle. */
  handle: string | null;
  size?: keyof typeof SIZE;
  className?: string;
}

/** Decorative: the name it stands for is always in a label or text nearby. */
export function Avatar({ handle, size = "md", className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-deleted-account={handle === null ? "" : undefined}
      className={cn(
        "text-avatar-fg inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-[0.02em]",
        handle === null ? "bg-surface-fill-medium" : FILLS[fillIndex(handle) - 1],
        SIZE[size],
        className,
      )}
    >
      {handle === null ? null : initialsOf(handle)}
    </span>
  );
}

/** The glyph sizes of the mockup: in menus (16 px), the channel header
 * (26 px), dialog headers (28 px) and Browse cards (32 px). */
const GLYPH_SIZE = {
  sm: "size-4 rounded-sm text-[9px]",
  lg: "size-[26px] rounded-[7px] text-[13px]",
  xl: "size-7 rounded-lg text-[14px]",
  xxl: "size-8 rounded-[9px] text-[14px]",
} as const;

/** A channel's glyph: its first letter on a fill (`glyph`). */
export function ChannelGlyph({
  name,
  size = "sm",
  className,
}: {
  name: string;
  size?: keyof typeof GLYPH_SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "text-avatar-fg inline-grid shrink-0 place-items-center leading-none font-bold",
        GLYPH_SIZE[size],
        FILLS[fillIndex(name) - 1],
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
