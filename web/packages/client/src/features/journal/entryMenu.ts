// The journal card's menu, as data (ported from
// `ResearchActivityFeed.tsx:153-185`).
//
// Pure, so the layout and the keycaps per entry kind are testable without
// driving a popup: which items exist depends on the entry, and getting that
// wrong — a Retry on a tweet still being hydrated, an "Open on X" on a plain
// link — is the failure worth pinning.

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
 * otherwise what the user entered. */
export function journalEntryUrl(entry: JournalEntry): string | null {
  if (entry.kind === "link") return entry.url;
  return entry.tweet?.url ?? entry.url;
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
