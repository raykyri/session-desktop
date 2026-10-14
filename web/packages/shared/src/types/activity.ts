// The Home feed: root research questions in one keyset-paginated stream.
// Ported from the desktop `src/lib/journal.ts`; journal entries were removed.

import { z } from "zod";

import { recentActivityCursorSchema, recentResearchQuerySchema } from "./research.js";

export const recentActivityScopeSchema = z.enum(["all", "mine", "workspace"]);

export type RecentActivityScope = z.infer<typeof recentActivityScopeSchema>;

export const recentActivityItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("research-query"),
    occurredAt: z.number(),
    query: recentResearchQuerySchema,
  }),
]);

export type RecentActivityItem = z.infer<typeof recentActivityItemSchema>;

export const recentActivityPageSchema = z.object({
  items: z.array(recentActivityItemSchema),
  nextCursor: recentActivityCursorSchema.nullish(),
});

export type RecentActivityPage = z.infer<typeof recentActivityPageSchema>;
