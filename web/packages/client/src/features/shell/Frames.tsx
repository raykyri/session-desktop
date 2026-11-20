// The two kinds of screen inside the shell's scroll container (02 §2, §3.1):
// a feed (rows of `[card | side column]` in the layout's grid) and a page
// (one centred column). Both reserve the app bar's height at the top and end
// with the site footer (W2.7).

import type { ReactNode } from "react";

import { useNavigationStore } from "../../stores/navigation.js";

import { SiteFooter } from "./SiteFooter.js";

/** A feed: the rows go in `children`, each a `FeedRow`. */
export function FeedFrame({ children }: { children: ReactNode }) {
  const layout = useNavigationStore((state) => state.layout);
  return (
    <div className="feed-inner" data-layout={layout}>
      {children}
      <SiteFooter />
    </div>
  );
}

/** One feed row: the card cell, then the side column. A row whose first cell
 * is the channel header passes `head`: it spans the columns as §3.1 says and
 * the app bar does not align to it. */
export function FeedRow({
  children,
  side,
  head = false,
}: {
  children: ReactNode;
  side?: ReactNode;
  head?: boolean;
}) {
  return (
    <div className="feed-row">
      <div data-row-head={head ? "" : undefined} className="min-w-0">
        {children}
      </div>
      {head ? null : <aside className="min-w-0">{side}</aside>}
    </div>
  );
}

/**
 * Stands in for a feed until the replica provides its rows (02 §9): one row
 * with an empty card, so the columns, the bar's alignment and the footer are
 * in place.
 */
export function FeedPlaceholder() {
  return (
    <FeedRow>
      <div
        role="status"
        aria-label="Loading"
        aria-busy="true"
        data-placeholder=""
        className="bg-surface-card flex flex-col gap-2.5 rounded-xl px-5 pt-[18px] pb-4 shadow-[0_0_0_1px_var(--surface-border-faint)]"
      >
        <span className="bg-surface-fill-medium h-3.5 w-3/5 rounded" />
        <span className="bg-surface-fill-subtle h-3 w-full rounded" />
        <span className="bg-surface-fill-subtle h-3 w-4/5 rounded" />
      </div>
    </FeedRow>
  );
}

/** A page: `title` is its heading (the mockup's 22 px page `h2`). */
export function PageFrame({
  title,
  narrow = false,
  children,
}: {
  title: string;
  narrow?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="page-inner" data-width={narrow ? "narrow" : undefined}>
      <h2 className="text-fg-heading m-0 mb-2 text-[22px] font-bold tracking-[-0.015em]">
        {title}
      </h2>
      {children}
      <SiteFooter />
    </div>
  );
}

/** The body of a page whose content needs the replica or a procedure the
 * server does not have yet. */
export function NotBuiltYet() {
  return (
    <p data-placeholder="" className="text-fg-faint m-0 text-sm">
      Not available yet.
    </p>
  );
}
