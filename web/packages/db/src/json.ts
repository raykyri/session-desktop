// JSON columns. Drizzle's `text({ mode: "json" })` gives back whatever
// `JSON.parse` produced; nothing about the column type says the value still
// matches the shape the code expects. Every read therefore goes through
// {@link parseJsonColumn} with the zod schema from `@session/shared`
// (`docs/02-domain-model-and-database.md` §1), so a row written by an older
// build, a hand-edited database, or a partially-failed migration surfaces as
// an error naming the column instead of as an undefined field deep in a
// render.
//
// The db-local schema below covers the JSON payload that has no wire type in
// `shared`: one attempt's token usage.

import { z } from "zod";

/** Token counts as the AI SDK reports them for one attempt. */
export const attemptUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
});

export type AttemptUsage = z.infer<typeof attemptUsageSchema>;

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

/**
 * {@link parseJsonColumn} for a column holding a wire type from
 * `@session/shared/wire`, returned as that type.
 *
 * A zod schema's output marks an optional key `?: T | undefined`, which
 * `exactOptionalPropertyTypes` does not accept where the wire type writes
 * `?: T`. A value parsed from JSON has no `undefined` members, so the parsed
 * value is the wire type; `test/wireSchemas.test.ts` in `shared` checks that
 * each schema and its wire type agree.
 */
export function parseWireColumn<TWire>(schema: z.ZodType, value: unknown, column: string): TWire {
  return parseJsonColumn(schema, value, column) as TWire;
}

/** {@link parseWireColumn} for a nullable column. */
export function parseNullableWireColumn<TWire>(
  schema: z.ZodType,
  value: unknown,
  column: string,
): TWire | null {
  return value === null || value === undefined ? null : parseWireColumn(schema, value, column);
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
