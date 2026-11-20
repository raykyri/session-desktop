// The web's Home feed types: root research nodes in one keyset-paginated
// stream (`journal/cursor.ts`). The entries are the wire
// `RecentResearchQuery`; the page and cursor shapes around them are the
// web's, since the desktop feed is not paginated this way.

import { z } from "zod";

import { recentResearchQueryCursorSchema, recentResearchQuerySchema } from "../schemas/research.js";
import type { RecentResearchQuery, RecentResearchQueryCursor } from "../wire/index.js";

/** Stable keyset cursor for the Recent Activity feed. Source rank is a
 * deterministic tie-breaker between item sources (`journal/cursor.ts`). */
export const recentActivityCursorSchema = z.object({
  occurredAt: z.number(),
  sourceRank: z.number(),
  id: z.string(),
});

export type RecentActivityCursor = z.infer<typeof recentActivityCursorSchema>;

export const recentActivityScopeSchema = z.enum(["all", "mine", "workspace"]);

export type RecentActivityScope = z.infer<typeof recentActivityScopeSchema>;

export const recentActivityItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("research-query"),
    occurredAt: z.number(),
    /** The workspace of the item's thread, so a link from a feed that spans
     * workspaces opens the thread in its own. */
    workspaceId: z.string().nullish(),
    query: recentResearchQuerySchema,
  }),
]);

/** Declared rather than inferred so `query` is the wire type; the schema
 * validates the same shape. */
export interface RecentActivityItem {
  kind: "research-query";
  occurredAt: number;
  workspaceId?: string | null;
  query: RecentResearchQuery;
}

export const recentActivityPageSchema = z.object({
  items: z.array(recentActivityItemSchema),
  nextCursor: recentActivityCursorSchema.nullish(),
});

export interface RecentActivityPage {
  items: RecentActivityItem[];
  nextCursor?: RecentActivityCursor | null;
}

/** Root research nodes alone, newest first: `feed.recentQueries`. */
export const recentResearchQueryPageSchema = z.object({
  items: z.array(recentResearchQuerySchema),
  nextCursor: recentResearchQueryCursorSchema.nullish(),
});

export interface RecentResearchQueryPage {
  items: RecentResearchQuery[];
  nextCursor?: RecentResearchQueryCursor | null;
}
