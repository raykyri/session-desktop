// What a widget reads from the answer around it (the desktop's
// `src/lib/sessionWidgetActions.ts` contexts and `SessionWidgetStreamingContext`).
//
// `ResearchMarkdown` provides `WidgetAnswerContext` for an answer rendered
// with `widgetNodeId`. The thread page provides the other two:
//
// - `WidgetChangeContext`: the "Ask for widget changes" handler. It receives
//   the answer (with the widget's revision as `artifact` once registered) and
//   the widget's HTML, and typically puts `widgetChangePrompt(answer, html,
//   draft)` (`@session/shared/lib/sessionWidgetActions`) in the composer.
//   Without it the button is hidden. `blocked` disables the button with that
//   text as its title (for example while a follow-up cannot be asked).
// - `SessionWidgetStreamingContext`: true while the answer is streaming, so
//   its complete widget blocks are shown but not recorded as revisions yet.

import type { WidgetAnswer } from "@session/shared/lib/sessionWidgetActions";
import { createContext } from "react";

export type { WidgetAnswer };

export const WidgetAnswerContext = createContext<WidgetAnswer | null>(null);

export interface WidgetChangeHandler {
  ask: (answer: WidgetAnswer, html: string) => void;
  /** Why the reader cannot ask for changes now; null or absent when they can. */
  blocked?: string | null;
}
export const WidgetChangeContext = createContext<WidgetChangeHandler | null>(null);

export const SessionWidgetStreamingContext = createContext(false);
