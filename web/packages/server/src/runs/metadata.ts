// Metadata runs: titles, summary lines and context summaries on
// `METADATA_MODEL_ID` (`04-agent-runtime.md` §9).
//
// Each call is one structured provider call. Nothing here reads or writes a
// thread: a new thread's title and summary line are the final steps of its
// run (`03` E2), which bills the calls through its ledger meter (the `wrap`
// option) and writes the results through the fenced store (`loop.ts`).

import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelEntry } from "@session/shared";
import {
  METADATA_MODEL_ID,
  RESEARCH_TITLE_MAX_CHARS,
  sanitizeResearchTitle,
} from "@session/shared";
import { Output, generateText } from "ai";
import { z } from "zod";

import type { Logger } from "../logger.js";

import { classifyRunError } from "./errors.js";
import type { CallKind } from "./ledger.js";
import type { Providers } from "./providers.js";

const titleSchema = z.object({ title: z.string() });
const summarySchema = z.object({ summary: z.string() });

/** The longest summary line kept (`thread.sum`). */
export const SUMMARY_LINE_MAX_CHARS = 280;

const TITLE_SYSTEM =
  "You name research threads. Given a question and the opening of its answer, write a short " +
  "title for the thread: a noun phrase in sentence case, no final period, no quotation marks, " +
  `at most ${RESEARCH_TITLE_MAX_CHARS} characters. Name the subject, not the act of asking.`;

const SUMMARY_LINE_SYSTEM =
  "You summarize research answers for a feed. Given a question and its answer, write one " +
  `sentence of at most ${SUMMARY_LINE_MAX_CHARS} characters that states what the answer ` +
  "concludes. Plain text, no Markdown, no preamble.";

const CONTEXT_SUMMARY_SYSTEM =
  "Summarize the early part of a research conversation so it can remain in context. Include the " +
  "questions asked, conclusions reached, and facts needed by later turns. Omit hedging, redundant " +
  "phrasing, and superseded information. Use concise plain text.";

/** Puts a metadata call's model behind the run's ledger meter. */
export type ModelWrap = (
  model: LanguageModelV4,
  entry: ModelEntry,
  kind: CallKind,
) => LanguageModelV4;

export interface MetadataDeps {
  providers: Providers;
  logger: Logger;
}

interface MetadataCallInput {
  userId: string;
  /** Bills the call; absent, the call is not recorded (tests only). */
  wrap?: ModelWrap | undefined;
  signal?: AbortSignal | undefined;
}

export interface TitleInput extends MetadataCallInput {
  /** The run the title is for. */
  runId: string;
  question: string;
  /** The opening of the answer, if there is one yet. */
  opening: string;
}

export interface SummaryLineInput extends MetadataCallInput {
  runId: string;
  question: string;
  answer: string;
}

export interface MetadataRunner {
  /** A sanitized title, or null when the model gave none or the call failed. */
  generateTitle(input: TitleInput): Promise<string | null>;
  /** The root answer's summary line, or null. */
  generateSummaryLine(input: SummaryLineInput): Promise<string | null>;
  /** The context compaction summarizer (`04-agent-runtime.md` §4). */
  summarize(input: MetadataCallInput & { text: string }): Promise<string | null>;
}

interface GenerateOptions<T> extends MetadataCallInput {
  kind: CallKind;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  name: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const points = [...trimmed];
  return points.length <= max
    ? trimmed
    : `${points
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

export function createMetadataRunner(deps: MetadataDeps): MetadataRunner {
  /** One structured metadata call with failure logging. */
  const generate = async <T>(options: GenerateOptions<T>): Promise<T | null> => {
    const resolved = deps.providers.resolve(METADATA_MODEL_ID);
    if (!resolved) {
      deps.logger.warn({ model: METADATA_MODEL_ID }, "metadata model is not configured");
      return null;
    }
    const model = options.wrap
      ? options.wrap(resolved.model, resolved.entry, options.kind)
      : resolved.model;
    try {
      const result = await generateText({
        model,
        system: options.system,
        prompt: options.prompt,
        providerOptions: resolved.providerOptions,
        maxRetries: 1,
        output: Output.object({ schema: options.schema, name: options.name }),
        ...(options.signal ? { abortSignal: options.signal } : {}),
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
    async generateTitle({ userId, question, opening, wrap, signal }) {
      const result = await generate({
        userId,
        wrap,
        signal,
        kind: "title",
        system: TITLE_SYSTEM,
        prompt: `Question:\n${question}\n\nAnswer opening:\n${opening.slice(0, 2_000) || "(no answer yet)"}`,
        schema: titleSchema,
        name: "research_title",
      });
      return (result === null ? undefined : sanitizeResearchTitle(result.title)) ?? null;
    },

    async generateSummaryLine({ userId, question, answer, wrap, signal }) {
      if (answer.trim() === "") {
        return null;
      }
      const result = await generate({
        userId,
        wrap,
        signal,
        kind: "summary",
        system: SUMMARY_LINE_SYSTEM,
        prompt: `Question:\n${question}\n\nAnswer:\n${answer.slice(0, 8_000)}`,
        schema: summarySchema,
        name: "answer_summary",
      });
      const line = result === null ? "" : clip(result.summary, SUMMARY_LINE_MAX_CHARS);
      return line === "" ? null : line;
    },

    async summarize({ text, userId, signal, wrap }) {
      if (text.trim() === "") {
        return null;
      }
      const result = await generate({
        userId,
        wrap,
        signal,
        kind: "context",
        system: CONTEXT_SUMMARY_SYSTEM,
        prompt: text,
        schema: summarySchema,
        name: "context_summary",
      });
      return result?.summary.trim() ?? null;
    },
  };
}
