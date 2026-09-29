// Metadata runs: titles, recaps, and context summaries.

import {
  nodes as nodesRepo,
  recaps as recapsRepo,
  snapshots as snapshotsRepo,
  trees as treesRepo,
  newId,
} from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { ResearchRecapCandidate } from "@session/shared";
import {
  DEFAULT_RECAP_INSTRUCTIONS,
  METADATA_MODEL_ID,
  RESEARCH_TITLE_MAX_CHARS,
  normalizeRecap,
  recapJobKey,
  recapSourceFitsBudget,
  recapSourceForNode,
  sanitizeResearchTitle,
  shouldScheduleRecap,
} from "@session/shared";
import { Output, generateText } from "ai";
import { z } from "zod";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import { emitFeedItemUpsertedForNode } from "../events/feed.js";
import type { Logger } from "../logger.js";

import { classifyRunError } from "./errors.js";
import type { Providers } from "./providers.js";
import { attemptUsageOf, recordAttemptUsage } from "./usage.js";

const titleSchema = z.object({ title: z.string() });
const recapSchema = z.object({ recap: z.string() });

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

const CONTEXT_SUMMARY_SYSTEM =
  "Summarize the early part of a research conversation so it can remain in context. Include the " +
  "questions asked, conclusions reached, and facts needed by later turns. Omit hedging, redundant " +
  "phrasing, and superseded information. Use concise plain text.";

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
  /** The context compaction summarizer (`04-agent-runtime.md` §4). */
  summarize(input: {
    text: string;
    userId: string;
    signal?: AbortSignal | undefined;
  }): Promise<string | null>;
  /** A candidate this server issued to this account, for
   * `recaps.applyCandidate`. */
  recallRecapCandidate(userId: string, id: string): ResearchRecapCandidate | null;
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
  const candidates = new Map<
    string,
    { candidate: ResearchRecapCandidate; userId: string; expiresAt: number }
  >();
  const pendingRecaps = new Set<string>();

  const emit = (userId: string, type: string, payload: Record<string, unknown>): void => {
    deps.eventBus.emit(userId, sessionEvent(type, payload));
  };

  /** One structured metadata call with usage accounting and failure logging. */
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
      const classified = classifyRunError(error);
      deps.logger.warn(
        { error, job: options.name, errorClass: classified.errorClass },
        "metadata run failed",
      );
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
      // Re-read after the await. The model takes seconds, and a rename in the
      // meantime is a deliberate act by the user; a generated title is a
      // default, and a default must not overwrite a decision.
      const current = nodesRepo.get(deps.db, userId, nodeId);
      if (!current) {
        return null;
      }
      if (current.title !== null && current.title !== undefined) {
        return current.title;
      }
      const renamed = nodesRepo.rename(deps.db, userId, nodeId, title);
      emit(userId, "research.node.updated", { node: renamed });
      emitFeedItemUpsertedForNode(deps, renamed.id);
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
      candidates.set(candidate.id, { candidate, userId, expiresAt: now + RECAP_CANDIDATE_TTL_MS });
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
          // What the node carried before the model was called. Applying a
          // recap from the dialog changes neither the snapshot nor the
          // revision, so without this the automatic recap comes back and
          // replaces the summary the user wrote while it was generating.
          expectedCurrentRecapId: node.recap?.id ?? null,
        });
        if (saved) {
          emit(userId, "research.node.updated", { node: saved });
          emitFeedItemUpsertedForNode(deps, saved.id);
        }
        return saved !== null;
      } finally {
        pendingRecaps.delete(key);
        // Every exit path settles the flag (`04-agent-runtime.md` §9).
        emit(userId, "research.recap.pending", { nodeId, pending: false });
      }
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

    recallRecapCandidate(userId, id) {
      const entry = candidates.get(id);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        candidates.delete(id);
        return null;
      }
      // Ids are ULIDs and unguessable, and `applyCandidate` re-checks the
      // answer revision anyway; the account check is here so neither of those
      // is what the isolation rests on.
      return entry.userId === userId ? entry.candidate : null;
    },

    isRecapPending(key) {
      return pendingRecaps.has(key);
    },
  };
  return runner;
}

/** Re-exported so the loop can dedupe a recap it is about to schedule. */
export { recapJobKey, shouldScheduleRecap };
