// Encyclopedia pages grown from the wikilinks in research answers. Ported
// from the desktop `src/types.ts`; `adapter` is folded into `model` (a
// registry id) and `generatedBy` records which model wrote the current body.

import { z } from "zod";

export const encyclopediaPageStatusSchema = z.enum(["generating", "ready", "failed"]);

export type EncyclopediaPageStatus = z.infer<typeof encyclopediaPageStatusSchema>;

/** Where a page was requested from: a research answer (node) or another
 * page. Backlinks render from this list. */
export const encyclopediaSourceSchema = z.object({
  nodeId: z.string().nullish(),
  treeId: z.string().nullish(),
  pageSlug: z.string().nullish(),
  question: z.string().nullish(),
  excerpt: z.string(),
  siblingTerms: z.array(z.string()).optional(),
  createdAt: z.number(),
});

export type EncyclopediaSource = z.infer<typeof encyclopediaSourceSchema>;

export const encyclopediaPageSchema = z.object({
  slug: z.string(),
  term: z.string(),
  title: z.string(),
  /** Markdown body without the title heading; empty while generating. */
  body: z.string(),
  status: encyclopediaPageStatusSchema,
  error: z.string().nullish(),
  /** Registry id of the model the page was requested on. */
  model: z.string(),
  /** What wrote the current body; absent until the first generation lands. */
  generatedBy: z.string().nullish(),
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sources: z.array(encyclopediaSourceSchema),
  /** Slugs of the wikilinks in `body`. */
  links: z.array(z.string()),
});

export type EncyclopediaPage = z.infer<typeof encyclopediaPageSchema>;

export const encyclopediaPageSummarySchema = z.object({
  slug: z.string(),
  term: z.string(),
  title: z.string(),
  status: encyclopediaPageStatusSchema,
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sourceCount: z.number(),
});

export type EncyclopediaPageSummary = z.infer<typeof encyclopediaPageSummarySchema>;

export const encyclopediaPageRequestSchema = z.object({
  workspaceId: z.string(),
  term: z.string(),
  source: z.object({
    nodeId: z.string().nullish(),
    treeId: z.string().nullish(),
    pageSlug: z.string().nullish(),
    question: z.string().nullish(),
    excerpt: z.string(),
    siblingTerms: z.array(z.string()),
  }),
});

export type EncyclopediaPageRequest = z.infer<typeof encyclopediaPageRequestSchema>;
