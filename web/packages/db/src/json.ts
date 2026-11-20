// JSON columns. Drizzle's `text({ mode: "json" })` gives back whatever
// `JSON.parse` produced; nothing about the column type says the value still
// matches the shape the code expects. Every read therefore goes through
// {@link parseJsonColumn} with the zod schema from `@session/shared`
// (`docs/02-domain-model-and-database.md` §1), so a row written by an older
// build, a hand-edited database, or a partially-failed migration surfaces as
// an error naming the column instead of as an undefined field deep in a
// render.

import type { z } from "zod";

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
