// The postMessage bridge between the app and a widget frame
// (`11-artifacts-and-browser.md` §4).
//
// A widget page runs HTML an agent wrote, so every message from it is hostile
// input. A message is accepted only when:
//
// - it comes from this widget's own frame window (`event.source`);
// - its origin is `"null"`: the frame is sandboxed without
//   `allow-same-origin`, so a message from any real origin is not this page;
// - the frame has not exceeded its message budget (a widget that floods the
//   app loses its messages, not the app's responsiveness);
// - it matches one of the bridge's message shapes. Saved inputs must be JSON
//   of at most 16 KiB, checked before anything serializes them.
//
// The app only ever sends the frame pings and the saved inputs it already
// holds for that frame's revision.

import { sessionWidgetFrameHeight } from "@session/shared/lib/sessionWidgets";
import { z } from "zod";

export type WidgetFrameMessage =
  | { type: "height"; height: number }
  | { type: "pong" }
  | { type: "unload" }
  | { type: "state-ready" }
  | { type: "state-save"; value: unknown };

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-widget-height"), height: z.number().finite() }),
  z.object({ type: z.literal("session-widget-pong") }),
  z.object({ type: z.literal("session-widget-unload") }),
  z.object({ type: z.literal("session-widget-state-ready") }),
  z.object({ type: z.literal("session-widget-state-save"), value: z.unknown() }),
]);

/** Messages one frame may send per second, with this burst. Session's own
 * scripts send a height report at most every 250 ms, a pong per second and a
 * saved-input message per change. */
const MESSAGES_PER_SECOND = 40;
const MESSAGE_BURST = 80;

interface Budget {
  tokens: number;
  updatedAt: number;
}
const budgets = new WeakMap<object, Budget>();

/** Takes one message from `source`'s budget; false when it is spent. */
export function takeWidgetMessage(source: object, now = performance.now()): boolean {
  const budget = budgets.get(source) ?? { tokens: MESSAGE_BURST, updatedAt: now };
  const tokens = Math.min(
    MESSAGE_BURST,
    budget.tokens + ((now - budget.updatedAt) / 1000) * MESSAGES_PER_SECOND,
  );
  const allowed = tokens >= 1;
  budgets.set(source, { tokens: allowed ? tokens - 1 : tokens, updatedAt: now });
  return allowed;
}

/**
 * The validated message `event` carries from `frameWindow`, or null. Each
 * listener calls this once per event, so the budget counts every message the
 * frame sends once per listener.
 */
export function widgetFrameMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frameWindow: Window | null | undefined,
): WidgetFrameMessage | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return null;
  if (!takeWidgetMessage(frameWindow)) return null;
  const parsed = messageSchema.safeParse(event.data);
  if (!parsed.success) return null;
  switch (parsed.data.type) {
    case "session-widget-height": {
      const height = sessionWidgetFrameHeight(parsed.data);
      return height === null ? null : { type: "height", height };
    }
    case "session-widget-pong":
      return { type: "pong" };
    case "session-widget-unload":
      return { type: "unload" };
    case "session-widget-state-ready":
      return { type: "state-ready" };
    case "session-widget-state-save":
      return { type: "state-save", value: parsed.data.value };
  }
}
