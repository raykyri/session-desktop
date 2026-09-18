// Metadata runs: titles, recaps, and encyclopedia pages
// (`04-agent-runtime.md` §9).
//
// All three are short, structured, tool-free `gemini-flash` calls that produce
// one string, and all three are derived data: a failure is silent and costs
// the thread a title or a summary, never its answer. The desktop rules are
// kept — the recap scheduling predicate and its dedupe key, the source caps,
// the 1200-character rejection, `research.recap.pending` on every exit path,
// title sanitization, and the page's linking instruction, title split, and
// recomputed links — and only the transport changed.

import {
  encyclopedia as encyclopediaRepo,
  nodes as nodesRepo,
  recaps as recapsRepo,
  snapshots as snapshotsRepo,
  trees as treesRepo,
  newId,
} from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { EncyclopediaPage, ResearchRecapCandidate } from "@session/shared";
import {
  DEFAULT_RECAP_INSTRUCTIONS,
  MAX_ENCYCLOPEDIA_EXCERPT_CHARS,
  MAX_ENCYCLOPEDIA_EXISTING_PAGES_IN_PROMPT,
  MAX_ENCYCLOPEDIA_QUESTION_CHARS,
  MAX_ENCYCLOPEDIA_SIBLING_TERMS,
  MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT,
  MAX_ENCYCLOPEDIA_TITLE_CHARS,
  METADATA_MODEL_ID,
  PAGE_LINKING_INSTRUCTION,
  RESEARCH_TITLE_MAX_CHARS,
  normalizePage,
  normalizeRecap,
  recapJobKey,
  recapSourceFitsBudget,
  recapSourceForNode,
  sanitizeResearchTitle,
  shouldScheduleRecap,
  splitTitle,
  truncateEncyclopediaText,
} from "@session/shared";
import { Output, generateText } from "ai";
import { z } from "zod";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import type { Logger } from "../logger.js";

import type { Providers } from "./providers.js";
import { attemptUsageOf, recordAttemptUsage } from "./usage.js";

const titleSchema = z.object({ title: z.string() });
const recapSchema = z.object({ recap: z.string() });
const pageSchema = z.object({ page: z.string() });

/** How long a generated recap candidate stays claimable by
 * `recaps.applyCandidate`. Long enough for the dialog to be read and
 * confirmed, short enough that the map cannot grow unbounded. */
export const RECAP_CANDIDATE_TTL_MS = 30 * 60 * 1000;

const TITLE_SYSTEM =
  "You name research threads. Given a question and the opening of its answer, write a short " +
  "title for the thread: a noun phrase in sentence case, no final period, no quotation marks, " +
  `at most ${RESEARCH_TITLE_MAX_CHARS} characters. Name the subject, not the act of asking.`;

const RECAP_SYSTEM =
  "You write recaps of research answers. Use only the supplied answer; add nothing and do not " +
  "speculate. Plain prose, no Markdown, no heading, no 'Summary:' label.";

const PAGE_SYSTEM =
  "You write short encyclopedia pages for a personal research workspace. Start with a level-1 " +
  "Markdown heading naming the term, then two to five short paragraphs a reader who met the " +
  "term in passing would want. Be concrete and factual; say plainly when something is " +
  "contested or unknown. No preamble, no closing summary, no lists of links.";

const CONTEXT_SUMMARY_SYSTEM =
  "You compress the early part of a research conversation so it can stay in context. Keep the " +
  "questions asked, the conclusions reached, and the facts later turns would need. Drop " +
  "phrasing, hedging, and anything superseded. Plain prose.";

export interface MetadataDeps {
  config: Config;
  db: SessionDatabase;
  eventBus: EventBus;
  providers: Providers;
  logger: Logger;
}

export interface MetadataRunner {
  generateTitle(userId: string, nodeId: string): Promise<string | null>;
  generateRecapCandidate(
    userId: string,
    nodeId: string,
    instructions?: string,
  ): Promise<ResearchRecapCandidate | null>;
  /** The automatic recap a completed run schedules. Saves it itself. */
  runScheduledRecap(userId: string, nodeId: string): Promise<boolean>;
  generatePage(userId: string, workspaceId: string, slug: string): Promise<EncyclopediaPage | null>;
  /** The context compaction summarizer (`04-agent-runtime.md` §4). */
  summarize(input: {
    text: string;
    userId: string;
    signal?: AbortSignal | undefined;
  }): Promise<string | null>;
  /** A candidate this server issued, for `recaps.applyCandidate`. */
  recallRecapCandidate(id: string): ResearchRecapCandidate | null;
  /** True when an automatic recap for this exact answer is already running. */
  isRecapPending(key: string): boolean;
}

interface GenerateOptions<T> {
  userId: string;
  nodeId: string | null;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  name: string;
  signal?: AbortSignal | undefined;
}

export function createMetadataRunner(deps: MetadataDeps): MetadataRunner {
  const candidates = new Map<string, { candidate: ResearchRecapCandidate; expiresAt: number }>();
  const pendingRecaps = new Set<string>();

  const emit = (userId: string, type: string, payload: Record<string, unknown>): void => {
    deps.eventBus.emit(userId, sessionEvent(type, payload));
  };

  /**
   * One structured `gemini-flash` call. Returns null on any failure: every
   * caller here is derived data, and a thread without a title is a smaller
   * problem than a thread that reports an error it cannot act on.
   */
  const generate = async <T>(options: GenerateOptions<T>): Promise<T | null> => {
    const resolved = deps.providers.resolve(METADATA_MODEL_ID);
    if (!resolved) {
      deps.logger.warn({ model: METADATA_MODEL_ID }, "metadata model is not configured");
      return null;
    }
    try {
      const result = await generateText({
        model: resolved.model,
        system: options.system,
        prompt: options.prompt,
        providerOptions: resolved.providerOptions,
        maxRetries: 1,
        output: Output.object({ schema: options.schema, name: options.name }),
        ...(options.signal ? { abortSignal: options.signal } : {}),
      });
      const usage = attemptUsageOf(result.totalUsage);
      recordAttemptUsage({
        db: deps.db,
        userId: options.userId,
        nodeId: options.nodeId,
        entry: resolved.entry,
        kind: "metadata",
        usage,
      });
      return result.output;
    } catch (error) {
      deps.logger.warn({ error, job: options.name }, "metadata run failed");
      return null;
    }
  };

  const answerText = (userId: string, nodeId: string): string | null => {
    const snapshot = snapshotsRepo.read(deps.db, userId, nodeId);
    if (!snapshot) {
      return null;
    }
    const node = nodesRepo.get(deps.db, userId, nodeId);
    if (!node) {
      return null;
    }
    return recapSourceForNode(node, snapshot.turns) ?? null;
  };

  const runner: MetadataRunner = {
    async generateTitle(userId, nodeId) {
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (!node) {
        return null;
      }
      const opening = (node.responsePreview ?? answerText(userId, nodeId) ?? "").slice(0, 2_000);
      const result = await generate({
        userId,
        nodeId,
        system: TITLE_SYSTEM,
        prompt: `Question:\n${node.prompt}\n\nAnswer opening:\n${opening || "(no answer yet)"}`,
        schema: titleSchema,
        name: "research_title",
      });
      const title = result === null ? undefined : sanitizeResearchTitle(result.title);
      if (title === undefined) {
        return null;
      }
      const renamed = nodesRepo.rename(deps.db, userId, nodeId, title);
      emit(userId, "research.node.updated", { node: renamed });
      // A thread takes its name from its root question.
      if (renamed.parentNodeId === null || renamed.parentNodeId === undefined) {
        const tree = treesRepo.rename(deps.db, userId, renamed.treeId, title);
        emit(userId, "research.tree.updated", { tree });
      }
      return title;
    },

    async generateRecapCandidate(userId, nodeId, instructions) {
      const node = nodesRepo.get(deps.db, userId, nodeId);
      const snapshot = snapshotsRepo.read(deps.db, userId, nodeId);
      if (!node || !snapshot) {
        return null;
      }
      const source = recapSourceForNode(node, snapshot.turns);
      if (source === undefined || !recapSourceFitsBudget(node, source)) {
        return null;
      }
      const used = instructions?.trim() || DEFAULT_RECAP_INSTRUCTIONS;
      const result = await generate({
        userId,
        nodeId,
        system: RECAP_SYSTEM,
        prompt: `Instructions:\n${used}\n\nQuestion:\n${node.prompt}\n\nAnswer:\n${source}`,
        schema: recapSchema,
        name: "research_recap",
      });
      const text = result === null ? undefined : normalizeRecap(result.recap);
      if (text === undefined) {
        return null;
      }
      const candidate: ResearchRecapCandidate = {
        id: newId(),
        text,
        responseRevision: snapshot.revision,
        generatedAt: Date.now(),
        model: METADATA_MODEL_ID,
        instructions: used,
      };
      const now = Date.now();
      for (const [id, entry] of candidates) {
        if (entry.expiresAt <= now) {
          candidates.delete(id);
        }
      }
      candidates.set(candidate.id, { candidate, expiresAt: now + RECAP_CANDIDATE_TTL_MS });
      return candidate;
    },

    async runScheduledRecap(userId, nodeId) {
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (!node || !shouldScheduleRecap(node)) {
        return false;
      }
      const key = recapJobKey(node);
      if (pendingRecaps.has(key)) {
        return false;
      }
      pendingRecaps.add(key);
      emit(userId, "research.recap.pending", { nodeId, pending: true });
      try {
        const candidate = await runner.generateRecapCandidate(userId, nodeId);
        if (candidate === null) {
          return false;
        }
        const saved = recapsRepo.save(deps.db, userId, {
          nodeId,
          text: candidate.text,
          responseRevision: candidate.responseRevision,
          model: candidate.model,
          expectedSnapshotAt: node.responseSnapshotAt ?? null,
        });
        if (saved) {
          emit(userId, "research.node.updated", { node: saved });
        }
        return saved !== null;
      } finally {
        pendingRecaps.delete(key);
        // Every exit path settles the flag (`04-agent-runtime.md` §9).
        emit(userId, "research.recap.pending", { nodeId, pending: false });
      }
    },

    async generatePage(userId, workspaceId, slug) {
      const page = encyclopediaRepo.getPage(deps.db, userId, workspaceId, slug);
      if (!page) {
        return null;
      }
      const existing = encyclopediaRepo
        .listPages(deps.db, userId, workspaceId)
        .filter((summary) => summary.slug !== slug)
        .slice(0, MAX_ENCYCLOPEDIA_EXISTING_PAGES_IN_PROMPT)
        .map((summary) => summary.title);
      const sources = page.sources.slice(0, MAX_ENCYCLOPEDIA_SOURCES_IN_PROMPT).map((source) => {
        const question =
          source.question === null || source.question === undefined
            ? ""
            : `Asked: ${truncateEncyclopediaText(source.question, MAX_ENCYCLOPEDIA_QUESTION_CHARS)}\n`;
        const siblings = (source.siblingTerms ?? [])
          .slice(0, MAX_ENCYCLOPEDIA_SIBLING_TERMS)
          .join(", ");
        return (
          `${question}Context: ${truncateEncyclopediaText(source.excerpt, MAX_ENCYCLOPEDIA_EXCERPT_CHARS)}` +
          (siblings === "" ? "" : `\nNearby terms: ${siblings}`)
        );
      });
      const prompt = [
        `Term: ${truncateEncyclopediaText(page.term, MAX_ENCYCLOPEDIA_TITLE_CHARS)}`,
        sources.length === 0 ? "" : `Where it appeared:\n\n${sources.join("\n\n")}`,
        existing.length === 0 ? "" : `Pages that already exist: ${existing.join(", ")}`,
        PAGE_LINKING_INSTRUCTION,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const result = await generate({
        userId,
        nodeId: null,
        system: PAGE_SYSTEM,
        prompt,
        schema: pageSchema,
        name: "encyclopedia_page",
      });
      const markdown = result === null ? null : normalizePage(result.page);
      if (markdown === null) {
        const failed = encyclopediaRepo.failPage(
          deps.db,
          userId,
          workspaceId,
          slug,
          "the page could not be generated",
        );
        if (failed) {
          emit(userId, "encyclopedia.page.updated", { page: failed });
        }
        return failed;
      }
      const split = splitTitle(markdown, page.term);
      const saved = encyclopediaRepo.savePage(deps.db, userId, {
        workspaceId,
        slug,
        title: split.title,
        body: split.body,
        generatedBy: METADATA_MODEL_ID,
      });
      emit(userId, "encyclopedia.page.updated", { page: saved });
      return saved;
    },

    async summarize({ text, userId, signal }) {
      if (text.trim() === "") {
        return null;
      }
      const result = await generate({
        userId,
        nodeId: null,
        system: CONTEXT_SUMMARY_SYSTEM,
        prompt: text,
        schema: recapSchema,
        name: "context_summary",
        signal,
      });
      return result?.recap.trim() ?? null;
    },

    recallRecapCandidate(id) {
      const entry = candidates.get(id);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        candidates.delete(id);
        return null;
      }
      return entry.candidate;
    },

    isRecapPending(key) {
      return pendingRecaps.has(key);
    },
  };
  return runner;
}

/** Re-exported so the loop can dedupe a recap it is about to schedule. */
export { recapJobKey, shouldScheduleRecap };
