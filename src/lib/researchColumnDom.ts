// DOM lookups for the column strip. The column model itself is in the shared
// researchColumns module, which has no DOM access.

import { columnSelector, type ResearchColumnId } from "@session/shared/lib/researchColumns";

/** The id of the column that holds `element`, or null outside the strip. */
export function columnIdOf(element: Element | null | undefined): ResearchColumnId | null {
  const id = element?.closest<HTMLElement>(columnSelector())?.dataset.researchColumn;
  return id && /^(feed|placeholder|[TANE]\d+)$/.test(id) ? (id as ResearchColumnId) : null;
}
