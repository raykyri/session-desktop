// The mixed Home feed: journal entries and research questions in one
// keyset-paginated stream. Ported from the desktop `src/lib/journal.ts`.

import { z } from "zod";

import { journalEntrySchema } from "./journal.js";
import { recentActivityCursorSchema, recentResearchQuerySchema } from "./research.js";

export const recentActivityItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("journal"),
    occurredAt: z.number(),
    entry: journalEntrySchema,
  }),
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
