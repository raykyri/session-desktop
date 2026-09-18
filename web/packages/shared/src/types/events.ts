// The server-sent event envelope (`03-api-and-events.md` §3). Taken from the
// desktop's `events.rs` without `paneId` and `agentId` — the web has neither
// panes nor agent records — and with `seq` carried inside run event payloads.
//
// The envelope is deliberately loose: `researchEvents.ts` narrows a raw event
// into the closed union the client's reducers accept, and classifies anything
// it does not recognize as `unsupported` so a newer server triggers a scoped
// refetch rather than a silent drop.

import { z } from "zod";

export const sessionEventSchema = z.object({
  type: z.string(),
  /** Run events include `nodeId` and `seq`. */
  payload: z.record(z.string(), z.unknown()),
  /** Milliseconds since the Unix epoch. */
  timestamp: z.number(),
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;
