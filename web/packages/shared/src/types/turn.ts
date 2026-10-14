// The web's current transcript types, inferred from the schemas in
// `../schemas/turn.ts`. The plain declarations in `../wire/turn.ts` describe
// the same shape without the `.loose()` index signatures, and
// `test/wireSchemas.test.ts` checks that the two agree. Phase 2 moves the
// web's importers to the wire types.

import type { z } from "zod";

import type { threadParticipantSchema, turnBlockSchema, turnSchema } from "../schemas/turn.js";

export { isTurn, threadParticipantSchema, turnBlockSchema, turnSchema } from "../schemas/turn.js";

export type TurnBlock = z.infer<typeof turnBlockSchema>;

export type ThreadParticipant = z.infer<typeof threadParticipantSchema>;

export type Turn = z.infer<typeof turnSchema>;
