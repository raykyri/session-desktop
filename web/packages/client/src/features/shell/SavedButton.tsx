// Saved in the app bar (02 §2.2 item 5; `savedBtn` variant `e`): a 30 px
// pill with the bookmark and the count of saved threads, a 30 px circle with
// the bookmark alone at zero. The bookmark is filled while anything is saved.
// It is a link to `/saved`, current there.

import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { BookmarkIcon } from "./icons.js";
import { ROUND_BUTTON } from "./menuStyles.js";

export function savedLabel(count: number): string {
  return count > 0 ? `Saved, ${count}` : "Saved";
}

export function SavedButton({ count, current }: { count: number; current: boolean }) {
  const has = count > 0;
  return (
    <Link
      to="/saved"
      search={{}}
      title="Saved"
      aria-label={savedLabel(count)}
      aria-current={current ? "page" : undefined}
      className={cn(
        ROUND_BUTTON,
        "gap-1 text-xs font-semibold tabular-nums",
        has ? "text-fg-heading px-[9px]" : "w-[30px] p-0",
        current && "bg-control",
        FOCUS_RING,
      )}
    >
      <BookmarkIcon size={13} filled={has} />
      {has ? <span aria-hidden="true">{count}</span> : null}
    </Link>
  );
}
