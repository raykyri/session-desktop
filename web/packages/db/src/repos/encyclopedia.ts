// Encyclopedia pages (`docs/02-domain-model-and-database.md` §5.10).

import type {
  EncyclopediaPage,
  EncyclopediaPageRequest,
  EncyclopediaPageSummary,
  EncyclopediaSource,
} from "@session/shared";
import {
  MAX_ENCYCLOPEDIA_EXCERPT_CHARS,
  MAX_ENCYCLOPEDIA_QUESTION_CHARS,
  MAX_ENCYCLOPEDIA_SIBLING_TERMS,
  MAX_WIKILINK_CHARS,
  encyclopediaSlug,
  truncateEncyclopediaText,
  validateEncyclopediaSlug,
  wikilinkTerms,
} from "@session/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { parseJsonColumn, stringListSchema } from "../json.js";
import { encyclopediaPages, encyclopediaSources } from "../schema/encyclopedia.js";
import { workspaces } from "../schema/workspaces.js";
import { now } from "../time.js";

/** A page keeps at most this many origins; the oldest are evicted. */
export const MAX_STORED_SOURCES = 50;

type PageRow = typeof encyclopediaPages.$inferSelect;
type SourceRow = typeof encyclopediaSources.$inferSelect;

function toSource(row: SourceRow): EncyclopediaSource {
  return {
    nodeId: row.nodeId,
    treeId: row.treeId,
    pageSlug: row.pageSlug,
    question: row.question,
    excerpt: row.excerpt,
    siblingTerms: parseJsonColumn(
      stringListSchema,
      row.siblingTermsJson,
      "encyclopedia_sources.sibling_terms_json",
    ),
    createdAt: row.createdAt,
  };
}

function toPage(row: PageRow, sources: EncyclopediaSource[]): EncyclopediaPage {
  return {
    slug: row.slug,
    term: row.term,
    title: row.title,
    body: row.body,
    status: row.status,
    error: row.error,
    model: row.model,
    generatedBy: row.generatedBy,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sources,
    links: parseJsonColumn(stringListSchema, row.linksJson, "encyclopedia_pages.links_json"),
  };
}

function sourcesFor(db: SessionDatabase, workspaceId: string, slug: string): EncyclopediaSource[] {
  return db
    .select()
    .from(encyclopediaSources)
    .where(
      and(eq(encyclopediaSources.workspaceId, workspaceId), eq(encyclopediaSources.slug, slug)),
    )
    .orderBy(asc(encyclopediaSources.createdAt), asc(encyclopediaSources.id))
    .all()
    .map(toSource);
}

function pageRow(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
): PageRow | undefined {
  return db
    .select()
    .from(encyclopediaPages)
    .where(
      and(
        eq(encyclopediaPages.userId, userId),
        eq(encyclopediaPages.workspaceId, workspaceId),
        eq(encyclopediaPages.slug, slug),
      ),
    )
    .get();
}

export function getPage(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
): EncyclopediaPage | null {
  validateEncyclopediaSlug(slug);
  const row = pageRow(db, userId, workspaceId, slug);
  return row ? toPage(row, sourcesFor(db, workspaceId, slug)) : null;
}

/** Listing order is `(lower(title), slug)` — alphabetical as a reader expects,
 * with the slug breaking ties deterministically. */
export function listPages(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): EncyclopediaPageSummary[] {
  const counts = new Map(
    db
      .select({
        slug: encyclopediaSources.slug,
        value: sql<number>`count(*)`,
      })
      .from(encyclopediaSources)
      .where(eq(encyclopediaSources.workspaceId, workspaceId))
      .groupBy(encyclopediaSources.slug)
      .all()
      .map((row) => [row.slug, row.value]),
  );
  return db
    .select()
    .from(encyclopediaPages)
    .where(
      and(eq(encyclopediaPages.userId, userId), eq(encyclopediaPages.workspaceId, workspaceId)),
    )
    .orderBy(sql`lower(${encyclopediaPages.title})`, asc(encyclopediaPages.slug))
    .all()
    .map((row) => ({
      slug: row.slug,
      term: row.term,
      title: row.title,
      status: row.status,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceCount: counts.get(row.slug) ?? 0,
    }));
}

function sanitizeSource(
  request: EncyclopediaPageRequest,
  at: number,
): Omit<SourceRow, "id" | "workspaceId" | "slug"> {
  const seen = new Set<string>();
  const siblingTerms = request.source.siblingTerms
    .map((term) => term.trim())
    .filter((term) => term !== "" && [...term].length <= MAX_WIKILINK_CHARS)
    .filter((term) => {
      const key = term.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, MAX_ENCYCLOPEDIA_SIBLING_TERMS);
  const question = request.source.question
    ? truncateEncyclopediaText(request.source.question, MAX_ENCYCLOPEDIA_QUESTION_CHARS)
    : null;
  return {
    nodeId: request.source.nodeId?.trim() || null,
    treeId: request.source.treeId?.trim() || null,
    pageSlug: request.source.pageSlug ? validateEncyclopediaSlug(request.source.pageSlug) : null,
    question: question === "" ? null : question,
    excerpt: truncateEncyclopediaText(request.source.excerpt, MAX_ENCYCLOPEDIA_EXCERPT_CHARS),
    siblingTermsJson: siblingTerms,
    createdAt: at,
  };
}

export interface RequestPageResult {
  page: EncyclopediaPage;
  /** True when this call is what puts the page into `generating` — the caller
   * schedules a generation run exactly then. */
  shouldGenerate: boolean;
}

/**
 * Returns the page for a term, creating it when it does not exist
 * (`encyclopedia.rs:765`).
 *
 * An existing page gains the request as a backlink unless it already records
 * the same origin: same node if the request names one, else same source page,
 * else the same excerpt verbatim. That ladder is why two links to the same
 * term from one answer do not become two backlinks, while the same term linked
 * from two different answers does.
 *
 * A page that previously failed is retried; a page that is `ready` or already
 * `generating` is left alone.
 */
export function requestPage(
  db: SessionDatabase,
  userId: string,
  request: EncyclopediaPageRequest,
): RequestPageResult {
  const term = request.term.trim();
  if (term === "" || [...term].length > MAX_WIKILINK_CHARS) {
    throw new Error(
      `an encyclopedia page needs a term of at most ${MAX_WIKILINK_CHARS} characters`,
    );
  }
  const slug = encyclopediaSlug(term);
  if (slug === "") {
    throw new Error(`'${term}' has no letters or digits to name a page by`);
  }
  return transact(db, (tx) => {
    // The page's primary key is (`workspace_id`, `slug`) rather than the
    // account, so a request naming a workspace the caller does not own would
    // otherwise take a slug out of its owner's namespace.
    const workspace = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, request.workspaceId)))
      .get();
    if (!workspace) {
      throw new Error(`research workspace ${request.workspaceId} was not found`);
    }
    const at = now();
    const source = sanitizeSource(request, at);
    const existing = pageRow(tx, userId, request.workspaceId, slug);
    if (!existing) {
      tx.insert(encyclopediaPages)
        .values({
          userId,
          workspaceId: request.workspaceId,
          slug,
          term,
          title: term,
          body: "",
          status: "generating",
          error: null,
          model: "gemini-flash",
          generatedBy: null,
          linksJson: [],
          createdAt: at,
          updatedAt: at,
        })
        .run();
      tx.insert(encyclopediaSources)
        .values({ id: newId(), workspaceId: request.workspaceId, slug, ...source })
        .run();
      const page = getPage(tx, userId, request.workspaceId, slug);
      if (!page) {
        throw new Error(`encyclopedia page ${slug} was not found`);
      }
      return { page, shouldGenerate: true };
    }
    const current = sourcesFor(tx, request.workspaceId, slug);
    const duplicate = current.some((candidate) => {
      if (source.nodeId !== null) {
        return candidate.nodeId === source.nodeId;
      }
      if (source.pageSlug !== null) {
        return candidate.pageSlug === source.pageSlug;
      }
      return candidate.excerpt === source.excerpt;
    });
    let changed = false;
    if (!duplicate) {
      tx.insert(encyclopediaSources)
        .values({ id: newId(), workspaceId: request.workspaceId, slug, ...source })
        .run();
      const excess = current.length + 1 - MAX_STORED_SOURCES;
      if (excess > 0) {
        const oldest = tx
          .select({ id: encyclopediaSources.id })
          .from(encyclopediaSources)
          .where(
            and(
              eq(encyclopediaSources.workspaceId, request.workspaceId),
              eq(encyclopediaSources.slug, slug),
            ),
          )
          .orderBy(asc(encyclopediaSources.createdAt), asc(encyclopediaSources.id))
          .limit(excess)
          .all();
        for (const row of oldest) {
          tx.delete(encyclopediaSources).where(eq(encyclopediaSources.id, row.id)).run();
        }
      }
      changed = true;
    }
    const retry = existing.status === "failed";
    if (retry) {
      tx.update(encyclopediaPages)
        .set({ status: "generating", error: null })
        .where(
          and(
            eq(encyclopediaPages.workspaceId, request.workspaceId),
            eq(encyclopediaPages.slug, slug),
          ),
        )
        .run();
      changed = true;
    }
    if (changed) {
      tx.update(encyclopediaPages)
        .set({ updatedAt: at })
        .where(
          and(
            eq(encyclopediaPages.workspaceId, request.workspaceId),
            eq(encyclopediaPages.slug, slug),
          ),
        )
        .run();
    }
    const page = getPage(tx, userId, request.workspaceId, slug);
    if (!page) {
      throw new Error(`encyclopedia page ${slug} was not found`);
    }
    return { page, shouldGenerate: retry };
  });
}

/** The slugs a body links to, minus the page's own — what `links_json` holds. */
export function linksFromBody(body: string, ownSlug: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const term of wikilinkTerms(body)) {
    const slug = encyclopediaSlug(term);
    if (slug === "" || slug === ownSlug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    links.push(slug);
  }
  return links;
}

export interface SavePageInput {
  workspaceId: string;
  slug: string;
  title: string;
  body: string;
  generatedBy: string;
}

/** Stores a generated body and recomputes the page's links from it. */
export function savePage(
  db: SessionDatabase,
  userId: string,
  input: SavePageInput,
): EncyclopediaPage {
  return transact(db, (tx) => {
    const existing = pageRow(tx, userId, input.workspaceId, input.slug);
    if (!existing) {
      throw new Error(`encyclopedia page ${input.slug} was not found`);
    }
    tx.update(encyclopediaPages)
      .set({
        title: input.title,
        body: input.body,
        status: "ready",
        error: null,
        generatedBy: input.generatedBy,
        linksJson: linksFromBody(input.body, input.slug),
        updatedAt: now(),
      })
      .where(
        and(
          eq(encyclopediaPages.workspaceId, input.workspaceId),
          eq(encyclopediaPages.slug, input.slug),
        ),
      )
      .run();
    const page = getPage(tx, userId, input.workspaceId, input.slug);
    if (!page) {
      throw new Error(`encyclopedia page ${input.slug} was not found`);
    }
    return page;
  });
}

export function failPage(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
  error: string,
): EncyclopediaPage | null {
  db.update(encyclopediaPages)
    .set({ status: "failed", error, updatedAt: now() })
    .where(
      and(
        eq(encyclopediaPages.userId, userId),
        eq(encyclopediaPages.workspaceId, workspaceId),
        eq(encyclopediaPages.slug, slug),
      ),
    )
    .run();
  return getPage(db, userId, workspaceId, slug);
}

/** Puts a ready page back into `generating` so it is rewritten. */
export function regeneratePage(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
): EncyclopediaPage {
  return transact(db, (tx) => {
    const existing = pageRow(tx, userId, workspaceId, slug);
    if (!existing) {
      throw new Error(`encyclopedia page ${slug} was not found`);
    }
    tx.update(encyclopediaPages)
      .set({ status: "generating", error: null, updatedAt: now() })
      .where(and(eq(encyclopediaPages.workspaceId, workspaceId), eq(encyclopediaPages.slug, slug)))
      .run();
    const page = getPage(tx, userId, workspaceId, slug);
    if (!page) {
      throw new Error(`encyclopedia page ${slug} was not found`);
    }
    return page;
  });
}

export function deletePage(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
): boolean {
  return transact(db, (tx) => {
    const existing = pageRow(tx, userId, workspaceId, slug);
    if (!existing) {
      return false;
    }
    tx.delete(encyclopediaSources)
      .where(
        and(eq(encyclopediaSources.workspaceId, workspaceId), eq(encyclopediaSources.slug, slug)),
      )
      .run();
    tx.delete(encyclopediaPages)
      .where(and(eq(encyclopediaPages.workspaceId, workspaceId), eq(encyclopediaPages.slug, slug)))
      .run();
    return true;
  });
}

/** Pages whose `links_json` names `slug` — the backlinks a page shows. */
export function backlinks(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  slug: string,
): EncyclopediaPageSummary[] {
  return listPages(db, userId, workspaceId).filter((summary) => {
    const page = getPage(db, userId, workspaceId, summary.slug);
    return page?.links.includes(slug) ?? false;
  });
}
