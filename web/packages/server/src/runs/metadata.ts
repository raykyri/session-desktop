// Metadata runs: titles and context summaries on `METADATA_MODEL_ID`
// (`04-agent-runtime.md` §9).
//
// Each call is one structured provider call with its usage recorded. Nothing
// here reads or writes a thread: the recaps, the title written back to a node
// and its thread, and the events they published went with the research API
// (plan `01` A2). M5a makes a new thread's title and summary the final steps
// of its run (`03` E2) and stores them on the thread record.

import type { SessionDatabase } from "@session/db";
import {
  METADATA_MODEL_ID,
  RESEARCH_TITLE_MAX_CHARS,
  sanitizeResearchTitle,
} from "@session/shared";
import { Output, generateText } from "ai";
import { z } from "zod";

import type { Logger } from "../logger.js";

import { classifyRunError } from "./errors.js";
import type { Providers } from "./providers.js";
import { attemptUsageOf, recordAttemptUsage } from "./usage.js";

const titleSchema = z.object({ title: z.string() });
const summarySchema = z.object({ summary: z.string() });

const TITLE_SYSTEM =
  "You name research threads. Given a question and the opening of its answer, write a short " +
  "title for the thread: a noun phrase in sentence case, no final period, no quotation marks, " +
  `at most ${RESEARCH_TITLE_MAX_CHARS} characters. Name the subject, not the act of asking.`;

const CONTEXT_SUMMARY_SYSTEM =
  "Summarize the early part of a research conversation so it can remain in context. Include the " +
  "questions asked, conclusions reached, and facts needed by later turns. Omit hedging, redundant " +
  "phrasing, and superseded information. Use concise plain text.";

export interface MetadataDeps {
  db: SessionDatabase;
  providers: Providers;
  logger: Logger;
}

export interface TitleInput {
  userId: string;
  /** The run the title is for; its usage row names it. */
  runId: string;
  question: string;
  /** The opening of the answer, if there is one yet. */
  opening: string;
}

export interface MetadataRunner {
  /** A sanitized title, or null when the model gave none or the call failed. */
  generateTitle(input: TitleInput): Promise<string | null>;
  /** The context compaction summarizer (`04-agent-runtime.md` §4). */
  summarize(input: {
    text: string;
    userId: string;
    signal?: AbortSignal | undefined;
  }): Promise<string | null>;
}

interface GenerateOptions<T> {
  userId: string;
  runId: string | null;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  name: string;
  signal?: AbortSignal | undefined;
}

export function createMetadataRunner(deps: MetadataDeps): MetadataRunner {
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
      recordAttemptUsage({
        db: deps.db,
        userId: options.userId,
        nodeId: options.runId,
        entry: resolved.entry,
        kind: "metadata",
        usage: attemptUsageOf(result.totalUsage),
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

  return {
    async generateTitle({ userId, runId, question, opening }) {
      const result = await generate({
        userId,
        runId,
        system: TITLE_SYSTEM,
        prompt: `Question:\n${question}\n\nAnswer opening:\n${opening.slice(0, 2_000) || "(no answer yet)"}`,
        schema: titleSchema,
        name: "research_title",
      });
      return (result === null ? undefined : sanitizeResearchTitle(result.title)) ?? null;
    },

    async summarize({ text, userId, signal }) {
      if (text.trim() === "") {
        return null;
      }
      const result = await generate({
        userId,
        runId: null,
        system: CONTEXT_SUMMARY_SYSTEM,
        prompt: text,
        schema: summarySchema,
        name: "context_summary",
        signal,
      });
      return result?.summary.trim() ?? null;
    },
  };
}
