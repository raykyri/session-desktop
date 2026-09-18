// JSON columns. Drizzle's `text({ mode: "json" })` gives back whatever
// `JSON.parse` produced; nothing about the column type says the value still
// matches the shape the code expects. Every read therefore goes through
// {@link parseJsonColumn} with the zod schema from `@session/shared`
// (`docs/02-domain-model-and-database.md` §1), so a row written by an older
// build, a hand-edited database, or a partially-failed migration surfaces as
// an error naming the column instead of as an undefined field deep in a
// render.
//
// The db-local schemas below cover the three JSON payloads that have no wire
// type in `shared`: a run's terminal outcome, one attempt's token usage, and
// the AI SDK `ModelMessage` values of `node_messages`. A `ModelMessage` is
// the SDK's type, not ours, so it is stored and returned opaquely — the
// runtime that wrote it is the only thing that interprets it.

import { researchNodeStatusSchema } from "@session/shared";
import { z } from "zod";

/** The terminal outcome recorded alongside a response snapshot, which boot
 * reconciliation adopts for a node that was still active when the process
 * died (`docs/02-domain-model-and-database.md` §5.7). */
export const runOutcomeSchema = z.object({
  status: researchNodeStatusSchema,
  error: z.string().nullish(),
  completedAt: z.number(),
});

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

/** Token counts as the AI SDK reports them for one attempt. */
export const attemptUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
});

export type AttemptUsage = z.infer<typeof attemptUsageSchema>;

/** One canonical conversation message. Opaque on purpose: the shape is the AI
 * SDK's `ModelMessage`, including provider metadata this package must not
 * reshape, so only its role is constrained. */
export const nodeMessageSchema = z
  .object({ role: z.enum(["system", "user", "assistant", "tool"]) })
  .loose();

export type NodeMessage = z.infer<typeof nodeMessageSchema>;

/** A list of strings, for `links_json` and `sibling_terms_json`. */
export const stringListSchema = z.array(z.string());

/**
 * Validates a value read out of a JSON column.
 *
 * @param schema the shared zod schema the column's contents must satisfy
 * @param value the parsed column value
 * @param column the column name, used in the error message
 */
export function parseJsonColumn<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  column = "json column",
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Failed to parse ${column}: invalid data schema (${result.error.message})`);
  }
  return result.data;
}

/** {@link parseJsonColumn} for a nullable column: `null` and `undefined` pass
 * through as `null` rather than failing validation. */
export function parseNullableJsonColumn<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  column = "json column",
): z.infer<TSchema> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseJsonColumn(schema, value, column);
}
