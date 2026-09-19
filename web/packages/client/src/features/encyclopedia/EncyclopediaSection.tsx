// The sidebar's encyclopedia list (`10-home-feed-journal-encyclopedia.md` §6,
// ported from `EncyclopediaSidebarSection.tsx`).
//
// Alphabetical by title, and hidden until the first page exists: pages are only
// ever created by clicking a wikilink, so an empty section would be a heading
// over nothing with no way to act on it.

import type { EncyclopediaPageSummary } from "@session/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useMemo } from "react";

import { useEncyclopediaPages } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { SIDEBAR_ROW, SIDEBAR_SECTION_HEADING } from "../sidebar/rows.js";

export function sortEncyclopediaPages(
  pages: readonly EncyclopediaPageSummary[],
): EncyclopediaPageSummary[] {
  return [...pages].sort(
    (left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
      left.slug.localeCompare(right.slug),
  );
}

export function EncyclopediaSection({
  workspaceId,
  activeSlug,
}: {
  workspaceId: string;
  activeSlug: string | null;
}) {
  const pages = useEncyclopediaPages(workspaceId);
  const sorted = useMemo(() => sortEncyclopediaPages(pages.data ?? []), [pages.data]);
  if (sorted.length === 0) return null;

  return (
    <section aria-label="Encyclopedia" className="flex min-w-0 flex-col gap-px px-2 pt-3">
      <div className={SIDEBAR_SECTION_HEADING}>Encyclopedia</div>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {sorted.map((page) => {
          const selected = page.slug === activeSlug;
          return (
            <li key={page.slug} className="min-w-0">
              <Link
                to="/e/$slug"
                params={{ slug: page.slug }}
                search={(previous: Record<string, unknown>) => previous}
                aria-current={selected ? "page" : undefined}
                title={
                  page.status === "failed"
                    ? `${page.title} (couldn’t create this page)`
                    : page.title
                }
                className={cn(SIDEBAR_ROW, selected && "bg-surface-sidebar-hover text-fg-strong")}
              >
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                {page.status === "generating" ? (
                  <LoaderCircle
                    size={13}
                    className="session-spin text-fg-subtle shrink-0"
                    aria-label="Creating page"
                  />
                ) : page.status === "failed" ? (
                  <CircleAlert
                    size={13}
                    className="text-status-failed shrink-0"
                    aria-label="Couldn’t create this page"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
