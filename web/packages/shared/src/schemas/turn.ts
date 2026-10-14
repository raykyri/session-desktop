// Zod schemas for the durable transcript format, `Turn` and `TurnBlock` in
// `../wire/turn.ts`. A run's answer is stored as an ordered list of turns; the
// timeline projection in `markdown/turnTimeline.ts` renders them, and
// `research/revision.ts` hashes their canonical JSON to produce the response
// revision that highlights and document edits are checked against.
// `test/wireSchemas.test.ts` checks the schemas against the wire types.

import { z } from "zod";

// Every schema in this module is `.loose()`, and that is load-bearing rather
// than laxity. A zod object strips unknown keys, and these objects are parsed
// on the way out of the `response_snapshots` and `run_turns` JSON columns —
// the same values `research/revision.ts` hashes. A field written by a newer
// server, or provider metadata the mapper starts carrying, would be dropped
// silently on read, and the canonical JSON of the stripped turns no longer
// hashes to the revision that was committed with them. A record that is
// content-addressed by its own bytes has to round-trip whatever it was stored
// with; the named fields below are the parts this build understands, not the
// whole of what a turn may contain.

export const turnBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).loose(),
  z
    .object({
      type: z.literal("toolUse"),
      id: z.string().nullish(),
      name: z.string(),
      input: z.unknown(),
    })
    .loose(),
  z
    .object({
      type: z.literal("toolResult"),
      toolUseId: z.string().nullish(),
      content: z.unknown(),
      isError: z.boolean(),
    })
    .loose(),
  z.object({ type: z.literal("raw"), value: z.unknown() }).loose(),
]);

export const threadParticipantSchema = z
  .object({
    kind: z.enum(["user", "assistant", "session"]),
    actorId: z.string(),
    adapter: z.string().nullish(),
    agentId: z.string().nullish(),
    label: z.string().nullish(),
  })
  .loose();

export const turnSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    sessionId: z.string().nullish(),
    role: z.string(),
    blocks: z.array(turnBlockSchema),
    sourceIndex: z.number(),
    /** Milliseconds since the Unix epoch when the turn was recorded. */
    timestamp: z.number().nullish(),
    participant: threadParticipantSchema.nullish(),
    status: z.enum(["superseded", "interrupted", "uncertain"]).nullish(),
    statusReason: z
      .enum(["codexRollback", "interrupted", "claudePromptBranch", "unknownBranch"])
      .nullish(),
    /** Model-context membership, independent from execution outcome. */
    contextStatus: z.literal("rolledBack").nullish(),
    nativeId: z.string().nullish(),
    parentNativeId: z.string().nullish(),
    nativeMessageId: z.string().nullish(),
  })
  .loose();

/**
 * Whether `value` is a well-formed turn.
 *
 * The one predicate for this question. There were three checks of the same
 * shape in the package — `turnSchema` plus two hand-written validators reading
 * disjoint field sets, so an event stream and a streamed payload disagreed
 * about what a turn is — and the schema is the definition, so the predicate is
 * the schema. Callers that hold an already-typed `Turn` do not need it; it is
 * for values arriving over the wire.
 */
export function isTurn(value: unknown): value is z.output<typeof turnSchema> {
  return turnSchema.safeParse(value).success;
}
