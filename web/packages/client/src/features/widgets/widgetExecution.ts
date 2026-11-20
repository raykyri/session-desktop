// The reader's execution choice for a widget, shared by every copy of it on
// screen (inline and expanded) and kept across remounts (the desktop's
// `sessionWidgetExecution.ts`). The desktop keys the choice by the widget
// page's content hash in its URL; here the page URLs are per-preview
// capability tokens, so the choice is keyed by the widget's HTML. Stopping a
// widget for taking focus revokes a remembered Run everywhere.

type WidgetExecution = "running" | "focus" | null;

const MAX_CHOICES = 256;
const choices = new Map<string, Exclude<WidgetExecution, null>>();
const listeners = new Set<() => void>();

export function readWidgetExecution(html: string | null | undefined): WidgetExecution {
  return html ? (choices.get(html) ?? null) : null;
}

export function rememberWidgetExecution(html: string, choice: Exclude<WidgetExecution, null>) {
  if (choices.get(html) === choice) return;
  choices.delete(html);
  choices.set(html, choice);
  if (choices.size > MAX_CHOICES) {
    const oldest = choices.keys().next().value;
    if (oldest !== undefined) choices.delete(oldest);
  }
  for (const listener of listeners) listener();
}

export function subscribeWidgetExecution(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
