// `[[Term]]` resolution for rendered answers (`08-design-system-and-styling.md`
// §5, `10-home-feed-journal-encyclopedia.md`).
//
// The shared remark transform renders wikilinks as `a` elements with a
// `data-wikilink` value and no destination. The encyclopedia context handles
// navigation when available; other surfaces render the terms without
// interaction.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type WikilinkStatus = "ready" | "generating" | "failed";

export interface WikilinkActions {
  /** Status of the page the term resolves to, or null when none exists. */
  resolve: (term: string) => WikilinkStatus | null;
  /** Open (or create) the term's page. `anchor` is the clicked element, from
   * which the provider gathers the surrounding block as generation context. */
  activate: (term: string, anchor: HTMLElement) => void;
  /** Whether rendered terms can open or create encyclopedia pages. */
  interactive: boolean;
  /** Whether missing or failed terms may request a new page. Defaults to
   * `interactive`. Guests can open existing pages but not create them. */
  canRequest?: boolean;
}

export const NOOP_WIKILINK_ACTIONS: WikilinkActions = {
  resolve: () => null,
  activate: () => undefined,
  interactive: false,
  canRequest: false,
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
