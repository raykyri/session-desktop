import { createContext } from "react";
import { stripSessionWidgetBlocks } from "./sessionWidgets";

export interface WidgetAnswer {
  nodeId: string;
  blocked?: string | null;
  answer: string;
}
export const WidgetAnswerContext = createContext<WidgetAnswer | null>(null);
export const WidgetChangeContext = createContext<((answer: WidgetAnswer, html: string) => void) | null>(null);

/** Carry source once and bounded prose: imported conversations have a 120 KiB
 * launch budget. A unique delimiter also works for HTML containing fences. */
export function widgetChangePrompt(answer: WidgetAnswer, html: string): string {
  let counter = 0;
  while (html.includes(`SESSION_WIDGET_SOURCE_${counter}`)) counter += 1;
  const boundary = `SESSION_WIDGET_SOURCE_${counter}`;
  const prose = [...stripSessionWidgetBlocks(answer.answer)].slice(0, 2000).join("");
  return `Revise the selected widget from answer ${answer.nodeId}.\n\nRequested changes: \n\nOriginating answer excerpt:\n${prose}\n\nSelected widget HTML follows between ${boundary} markers:\n${boundary}\n${html}\n${boundary}`;
}
