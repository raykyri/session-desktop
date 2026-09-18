// `[[Term]]` resolution for rendered answers (`08-design-system-and-styling.md`
// §5, `10-home-feed-journal-encyclopedia.md`).
//
// The remark transform in `shared` turns a wikilink into an `a` element with
// `data-wikilink="Term"` and no destination; what a click does is the
// encyclopedia's business, not the renderer's, so it arrives through this
// context. The default is inert on purpose: every surface that renders answer
// markdown (Home cards, the highlights feed, a thread) gets readable linked
// terms whether or not a page store is mounted above it, and only the
// encyclopedia track's provider makes them navigable.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type WikilinkStatus = "ready" | "generating" | "failed";

export interface WikilinkActions {
  /** Status of the page the term resolves to, or null when none exists. */
  resolve: (term: string) => WikilinkStatus | null;
  /** Open (or create) the term's page. `anchor` is the clicked element, from
   * which the provider gathers the surrounding block as generation context. */
  activate: (term: string, anchor: HTMLElement) => void;
  /** False for the no-op default: the link reads as linked but carries no
   * tooltip and does nothing, because there is nowhere for it to go. */
  interactive: boolean;
}

export const NOOP_WIKILINK_ACTIONS: WikilinkActions = {
  resolve: () => null,
  activate: () => undefined,
  interactive: false,
};

export const WikilinkActionsContext = createContext<WikilinkActions>(NOOP_WIKILINK_ACTIONS);

export function useWikilinkActions(): WikilinkActions {
  return useContext(WikilinkActionsContext);
}

export function WikilinkActionsProvider({
  actions,
  children,
}: {
  actions: WikilinkActions;
  children: ReactNode;
}) {
  return (
    <WikilinkActionsContext.Provider value={actions}>{children}</WikilinkActionsContext.Provider>
  );
}
