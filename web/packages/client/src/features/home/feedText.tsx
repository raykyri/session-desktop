// Text helpers for Home's cards, from the desktop's `ResearchActivityFeed.tsx`.

import { feedTextRuns } from "@session/shared/lib/feedLinkText";
import type { ReactNode } from "react";

/** Feed card text with each URL in a span drawn in the link color. The card
 * is one open button, so the URLs are not links. A URL breaks anywhere, so a
 * long one wraps inside the text column. */
export function feedText(text: string): ReactNode {
  const runs = feedTextRuns(text);
  if (!runs.some((run) => run.kind === "url")) return text;
  return runs.map((run, index) =>
    run.kind === "url" ? (
      <span key={index} className="text-accent break-all" data-research-feed-url="">
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/** A card's name in labels and announcements, at most 60 characters. */
export function shortName(name: string): string {
  const text = name.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
}
