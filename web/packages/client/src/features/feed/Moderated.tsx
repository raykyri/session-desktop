// Moderated items (04 §6.2, §6.3): one rendering for threads, branches,
// replies and comments. A hidden item's text is served to its author and
// the channel's owner, who see it under "Hidden by the channel owner";
// everyone else gets the item without text and sees that line alone. A
// removed item has no text for anyone. A thread's removed placeholder is
// its own card (`RemovedCard`).

import type { ModState } from "@session/mutators";

export function moderationLine(mod: ModState | null): string | null {
  if (mod === "hidden") return "Hidden by the channel owner";
  if (mod === "removed") return "Removed by the channel owner";
  return null;
}

/** The line over (or in place of) a moderated item's text. */
export function ModerationNote({
  mod,
  className = "modln",
}: {
  mod: ModState | null;
  className?: string;
}) {
  const line = moderationLine(mod);
  return line ? <p className={className}>{line}</p> : null;
}

/** A tree row's text: the moderation line in place of a text the reader
 * does not get, "[deleted]" for an author's deleted item. */
export function rowText(item: { mod: ModState | null; del: boolean }, text: string): string {
  if (item.del) return "[deleted]";
  if (item.mod !== null && text === "") return moderationLine(item.mod) ?? "";
  return text;
}
