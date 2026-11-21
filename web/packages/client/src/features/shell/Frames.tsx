// The two kinds of screen inside the shell's scroll container (02 §2, §3.1):
// a feed (rows of `[card | side column]` in the layout's grid) and a page
// (one centred column). Both reserve the app bar's height at the top and end
// with the site footer (W2.7).

import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";

import { useNavigationStore } from "../../stores/navigation.js";

import { SiteFooter } from "./SiteFooter.js";

/** A feed: the rows go in `children`, each a `FeedRow`. A channel feed
 * passes `channel` (its rows sit 2 px closer, as the mock's `.chfeed`). */
export function FeedFrame({
  children,
  channel = false,
}: {
  children: ReactNode;
  channel?: boolean;
}) {
  const layout = useNavigationStore((state) => state.layout);
  return (
    <div className="feed-inner" data-layout={layout} data-channel={channel ? "" : undefined}>
      {children}
      <SiteFooter />
    </div>
  );
}

/** One feed row: the card cell, then the side column. A row whose first cell
 * is the channel header passes `head`: it spans the columns as §3.1 says and
 * the app bar does not align to it. The banner, header and composer rows
 * pass `lead` (the mock's `.new-row` spacing). A thread's row passes its id
 * (`rowId`): the side column is then `data-side` for the row's controls. */
export function FeedRow({
  children,
  side,
  head = false,
  lead = false,
  rowId,
}: {
  children: ReactNode;
  side?: ReactNode;
  head?: boolean;
  lead?: boolean;
  rowId?: string;
}) {
  return (
    <div className={lead ? "feed-row lead" : "feed-row"} data-row-thread={rowId}>
      <div data-row-head={head ? "" : undefined} className="min-w-0">
        {children}
      </div>
      {head ? null : (
        <aside className="mgn min-w-0" data-side={rowId}>
          {side}
        </aside>
      )}
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

/**
 * Whether a page focuses its heading when it opens: true once the visitor
 * has moved from the screen the app loaded on (`AppShell` provides it). The
 * first screen of a load leaves focus at the document's start, so Tab
 * reaches the app bar first.
 */
export const PageHeadingFocusContext = createContext(false);

/** A page: `title` is its heading (the mockup's 22 px page `h2`). A route
 * change to a page focuses the heading without scrolling (02 §10.1, W10.1;
 * the mock's `go`), so a screen reader starts at the new page's name. */
export function PageFrame({
  title,
  narrow = false,
  action,
  children,
}: {
  title: string;
  narrow?: boolean;
  /** A control beside the heading (Browse's New channel, `.shead`). */
  action?: ReactNode;
  children?: ReactNode;
}) {
  const focusHeading = useContext(PageHeadingFocusContext);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusHeading) heading.current?.focus({ preventScroll: true });
  }, [focusHeading, pathname]);

  const h2 = (
    <h2
      ref={heading}
      tabIndex={-1}
      className="text-fg-heading m-0 mb-2 text-[22px] font-bold tracking-[-0.015em]"
    >
      {title}
    </h2>
  );
  return (
    <div className="page-inner" data-width={narrow ? "narrow" : undefined}>
      {action ? (
        <div className="shead">
          {h2}
          {action}
        </div>
      ) : (
        h2
      )}
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
