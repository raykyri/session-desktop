import { createContext } from "react";
import type { WidgetAnswer } from "@session/shared/lib/sessionWidgetActions";

// The answer and the change request handler a widget reads from its answer.
// The prompt builder (`widgetChangePrompt`) is shared with the web app
// (web/packages/shared/src/lib/sessionWidgetActions.ts).
export const WidgetAnswerContext = createContext<WidgetAnswer | null>(null);
export const WidgetChangeContext = createContext<((answer: WidgetAnswer, html: string) => void) | null>(null);
