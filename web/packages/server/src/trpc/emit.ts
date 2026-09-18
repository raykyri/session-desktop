// Publishing to the event bus from a procedure.
//
// Every emit happens after the repository call returns, which is after its
// transaction committed (`03-api-and-events.md` §3): a client that refetches
// on the event must never read the database before the write it describes.

import { sessionEvent } from "../events/bus.js";

import type { AppContext } from "./base.js";

export interface EmitterContext extends AppContext {
  user: NonNullable<AppContext["user"]>;
}

export function publish(ctx: EmitterContext, type: string, payload: Record<string, unknown>): void {
  ctx.eventBus.emit(ctx.user.id, sessionEvent(type, payload));
}
