// Wikilink activation (`10-home-feed-journal-encyclopedia.md` §6).
//
// The renderer emits a wikilink as an anchor carrying `data-wikilink="Term"`
// and nothing else; what a click does arrives through
// `WikilinkActionsContext` (`features/markdown/wikilinks.tsx`). This module is
// the encyclopedia's implementation of it: resolve a term against the cached
// page list, and on activation navigate to the page — requesting it first when
// none exists or the last attempt failed.
//
// The DOM half of the desktop's `encyclopedia.ts` (`wikilinkClickContext`)
// lives here rather than in `shared` because it reads the rendered block around
// the link; the text-shaping half (`buildWikilinkExcerpt`) is shared with the
// server, which re-applies it to whatever it receives.

import type { EncyclopediaPageSummary } from "@session/shared";
import {
  buildWikilinkExcerpt,
  ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT,
  encyclopediaSlug,
  stripWikilinks,
  wikilinkTerms,
} from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { requestEncyclopediaPage } from "../../api/api.js";
import { useEncyclopediaPages } from "../../api/queries.js";
import { pushErrorToast } from "../../lib/toast.js";
import type { WikilinkActions, WikilinkStatus } from "../markdown/index.js";

/** The elements that count as "the passage the term appeared in". A wikilink
 * inside a table cell belongs to that cell, not to the whole table. */
const BLOCK_SELECTOR = "p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,pre,dd,dt,figcaption,summary";

function blockText(element: Element | null | undefined): string {
  return stripWikilinks(element?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WikilinkClickContext {
  excerpt: string;
  siblingTerms: string[];
}

/**
 * The generation context for a clicked term: the surrounding block, its two
 * neighbors when there is budget left, and the other terms linked from the same
 * block.
 *
 * Sibling terms are read from the rendered anchors rather than from the text,
 * because by the time the markdown is in the DOM a wikilink is an anchor and
 * its `[[…]]` spelling is gone; `wikilinkTerms` still runs over the text for
 * the case where raw markdown reached the DOM unrendered.
 */
export function wikilinkClickContext(anchor: HTMLElement, term: string): WikilinkClickContext {
  const block = anchor.closest(BLOCK_SELECTOR) ?? anchor.parentElement;
  const center = blockText(block);
  const excerpt = buildWikilinkExcerpt(
    blockText(block?.previousElementSibling),
    center,
    blockText(block?.nextElementSibling),
    ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT,
  );

  const seen = new Set<string>([term]);
  const siblingTerms: string[] = [];
  for (const element of block?.querySelectorAll<HTMLElement>("[data-wikilink]") ?? []) {
    const sibling = element.dataset["wikilink"]?.trim();
    if (!sibling || seen.has(sibling)) continue;
    seen.add(sibling);
    siblingTerms.push(sibling);
  }
  for (const sibling of wikilinkTerms(block?.textContent ?? "")) {
    if (seen.has(sibling)) continue;
    seen.add(sibling);
    siblingTerms.push(sibling);
  }
  return { excerpt, siblingTerms };
}

/** Where a clicked term was read: a research answer, or another page. */
export type WikilinkOrigin =
  | { kind: "node"; nodeId: string; treeId: string; question?: string | null | undefined }
  | { kind: "page"; pageSlug: string };

export function statusForSlug(
  pages: readonly EncyclopediaPageSummary[] | undefined,
  slug: string,
): WikilinkStatus | null {
  return pages?.find((page) => page.slug === slug)?.status ?? null;
}

/**
 * The provider's actions. `resolve` is a cache read, so a rendered answer shows
 * which of its terms already have pages without a request per link; `activate`
 * navigates first and requests in the background, because the page view renders
 * a "writing…" state of its own and waiting on the mutation would leave the
 * click looking dead.
 */
export function useWikilinkActions(
  workspaceId: string,
  origin: WikilinkOrigin | null,
): WikilinkActions {
  const navigate = useNavigate();
  const pages = useEncyclopediaPages(workspaceId);
  const summaries = pages.data;

  return useMemo<WikilinkActions>(
    () => ({
      resolve: (term) => statusForSlug(summaries, encyclopediaSlug(term)),
      activate: (term, anchor) => {
        const slug = encyclopediaSlug(term);
        if (slug === "" || workspaceId === "") return;
        const status = statusForSlug(summaries, slug);
        if (status === null || status === "failed") {
          const context = wikilinkClickContext(anchor, term);
          void requestEncyclopediaPage({
            workspaceId,
            term,
            source: {
              nodeId: origin?.kind === "node" ? origin.nodeId : null,
              treeId: origin?.kind === "node" ? origin.treeId : null,
              pageSlug: origin?.kind === "page" ? origin.pageSlug : null,
              question: origin?.kind === "node" ? (origin.question ?? null) : null,
              excerpt: context.excerpt,
              siblingTerms: context.siblingTerms,
            },
          }).catch((error: unknown) => pushErrorToast("That page could not be requested", error));
        }
        void navigate({ to: "/e/$slug", params: { slug }, search: { ws: workspaceId } });
      },
      interactive: workspaceId !== "",
    }),
    [navigate, origin, summaries, workspaceId],
  );
}
