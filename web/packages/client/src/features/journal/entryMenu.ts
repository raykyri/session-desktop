// The journal card's menu, as data (ported from
// `ResearchActivityFeed.tsx:153-185`).
//
// Pure, so the layout and the keycaps per entry kind are testable without
// driving a popup: which items exist depends on the entry, and getting that
// wrong — a Retry on a tweet still being hydrated, an "Open on X" on a plain
// link — is the failure worth pinning.

import { safeHref } from "@session/shared";
import type { JournalEntry } from "@session/shared";

export type JournalMenuAction = "open" | "copy" | "retry" | "delete";

export interface JournalMenuItem {
  action: JournalMenuAction;
  label: string;
  /** Single-letter keycap shown on the row. */
  key: string;
  danger?: boolean;
}

/** The URL an entry stands for: the canonical permalink once hydrated,
 * otherwise what the user entered.
 *
 * Gated through `safeHref` even though `journal.add` only stores web URLs:
 * `journal.restore` and `journal.update` take a whole entry from the client, so
 * the stored URL is not a value this surface can assume was validated on the
 * way in. An entry whose URL does not survive the gate simply has nothing to
 * open or copy. */
export function journalEntryUrl(entry: JournalEntry): string | null {
  const stored = entry.kind === "link" ? entry.url : (entry.tweet?.url ?? entry.url);
  return safeHref(stored) ?? null;
}

export function journalEntryMenuItems(entry: JournalEntry): JournalMenuItem[] {
  const items: JournalMenuItem[] = [];
  if (journalEntryUrl(entry)) {
    items.push({
      action: "open",
      label: entry.kind === "tweet" ? "Open on X" : "Open link",
      key: "O",
    });
  }
  items.push({ action: "copy", label: "Copy link", key: "C" });
  if (entry.kind === "tweet" && entry.hydration !== "pending") {
    items.push({
      action: "retry",
      label: entry.hydration === "failed" ? "Retry tweet" : "Refresh tweet",
      key: "R",
    });
  }
  items.push({ action: "delete", label: "Delete", key: "D", danger: true });
  return items;
}
