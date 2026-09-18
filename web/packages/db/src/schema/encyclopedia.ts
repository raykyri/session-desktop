// Encyclopedia pages grown from the wikilinks in answers
// (`docs/02-domain-model-and-database.md` §3.5, §5.10).

import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const encyclopediaPages = sqliteTable(
  "encyclopedia_pages",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    term: text("term").notNull(),
    title: text("title").notNull(),
    /** Markdown without the title heading; empty while generating. */
    body: text("body").notNull().default(""),
    status: text("status", { enum: ["generating", "ready", "failed"] }).notNull(),
    error: text("error"),
    /** Registry id the page was requested on; always `gemini-flash` today. */
    model: text("model").notNull(),
    generatedBy: text("generated_by"),
    /** Slugs of the wikilinks in `body`, recomputed on every write. */
    linksJson: text("links_json", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.slug] }),
    index("encyclopedia_pages_title_idx").on(table.workspaceId, table.title),
  ],
);

/** Where a page was requested from. Capped at 50 per page, oldest evicted. */
export const encyclopediaSources = sqliteTable(
  "encyclopedia_sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    slug: text("slug").notNull(),
    nodeId: text("node_id"),
    treeId: text("tree_id"),
    pageSlug: text("page_slug"),
    question: text("question"),
    excerpt: text("excerpt").notNull(),
    siblingTermsJson: text("sibling_terms_json", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.slug],
      foreignColumns: [encyclopediaPages.workspaceId, encyclopediaPages.slug],
      name: "encyclopedia_sources_page_fk",
    }).onDelete("cascade"),
    index("encyclopedia_sources_page_idx").on(table.workspaceId, table.slug, table.createdAt),
  ],
);
