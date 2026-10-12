import { getResearchArtifactState, updateResearchArtifactState, type ArtifactStateAction, type ResearchArtifactRef, type ResearchArtifactState } from "./api";

export interface ArtifactStateEntry { config: ResearchArtifactState | null; error: string; pending: number; epoch: number; controlPending: number; sequence: number; }
const EMPTY: ArtifactStateEntry = { config: null, error: "", pending: 0, epoch: 0, controlPending: 0, sequence: 0 };
const entries = new Map<string, ArtifactStateEntry>();
const loading = new Map<string, Promise<void>>();
const staged = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown; epoch: number; sequence: number }>();
const queues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const references = new Map<string, ResearchArtifactRef>();
const handles = new Map<string, string>();
export const artifactStateKey = (reference: ResearchArtifactRef) => JSON.stringify([reference.treeId, reference.artifactId, reference.revision]);
export function readArtifactState(reference: ResearchArtifactRef | null) { return reference ? entries.get(artifactStateKey(reference)) ?? EMPTY : EMPTY; }
export function subscribeArtifactState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function patch(reference: ResearchArtifactRef, value: Partial<ArtifactStateEntry>) {
  entries.set(artifactStateKey(reference), { ...readArtifactState(reference), ...value });
  for (const listener of listeners) listener();
}
export function loadArtifactState(reference: ResearchArtifactRef): Promise<void> {
  const key = artifactStateKey(reference);
  if (readArtifactState(reference).config) return Promise.resolve();
  const existing = loading.get(key);
  if (existing) return existing;
  const work = getResearchArtifactState(reference).then(
    (config) => patch(reference, { config, error: "" }),
    () => patch(reference, { error: "Saved inputs unavailable. Retry to load them." }),
  ).finally(() => loading.delete(key));
  loading.set(key, work);
  return work;
}
export function changeArtifactState(reference: ResearchArtifactRef, action: ArtifactStateAction, value: unknown = null, savedSequence?: number): Promise<void> {
  const key = artifactStateKey(reference);
  const before = readArtifactState(reference);
  if (action !== "save") { const waiting = staged.get(key); if (waiting) clearTimeout(waiting.timer); staged.delete(key); }
  const epoch = before.epoch + (action === "save" ? 0 : 1);
  const sequence = savedSequence ?? before.sequence + 1;
  patch(reference, { sequence, pending: before.pending + 1, error: "", epoch, controlPending: before.controlPending + (action === "save" ? 0 : 1) });
  const work = (queues.get(key) ?? Promise.resolve()).then(async () => {
    try {
      const config = await updateResearchArtifactState(reference, action, value);
      const current = readArtifactState(reference);
      if (current.epoch === epoch && current.sequence === sequence) patch(reference, { config, error: "" });
    }
    catch { patch(reference, { error: action === "migrate" ? "The parent has no saved inputs, or they could not be copied." : "Inputs could not be saved. Try again." }); }
    finally { patch(reference, { pending: readArtifactState(reference).pending - 1, controlPending: readArtifactState(reference).controlPending - (action === "save" ? 0 : 1) }); }
  });
  queues.set(key, work);
  void work.finally(() => { if (queues.get(key) === work) queues.delete(key); });
  return work;
}

/** One buffer for all inline/expanded copies. Optimistic state prevents a slow
 * older write from restoring an obsolete value over newer user input. */
export function stageArtifactInputs(reference: ResearchArtifactRef, json: string) {
  const entry = readArtifactState(reference);
  if (!entry.config?.enabled || entry.controlPending > 0) return;
  const key = artifactStateKey(reference);
  if (json === JSON.stringify(entry.config.value) && !staged.has(key) && entry.pending === 0 && !entry.error) return;
  const previous = staged.get(key);
  const sequence = entry.sequence + 1;
  const value = JSON.parse(json) as unknown;
  staged.set(key, { timer: previous?.timer ?? setTimeout(() => flushArtifactInputs(reference), 250), value, epoch: entry.epoch, sequence });
  patch(reference, { sequence, config: { ...entry.config, value }, error: "" });
}
export function flushArtifactInputs(reference: ResearchArtifactRef) {
  const key = artifactStateKey(reference);
  const pending = staged.get(key);
  if (!pending) return;
  clearTimeout(pending.timer); staged.delete(key);
  const current = readArtifactState(reference);
  if (current.config?.enabled && current.epoch === pending.epoch && current.controlPending === 0) void changeArtifactState(reference, "save", pending.value, pending.sequence);
}

/** An opaque view handle lets expanded frames find the same revision without
 * placing owner identifiers or saved inputs in URLs. */
export function withArtifactState(url: string, reference: ResearchArtifactRef | null): string {
  if (!reference) return url;
  const key = artifactStateKey(reference);
  let handle = handles.get(key);
  if (!handle) { handle = crypto.randomUUID(); handles.set(key, handle); references.set(handle, reference); }
  const result = new URL(url);
  result.searchParams.set("session-artifact-state", handle);
  return result.toString();
}
export function artifactStateForUrl(url: string): ResearchArtifactRef | null {
  try { return references.get(new URL(url).searchParams.get("session-artifact-state") ?? "") ?? null; }
  catch { return null; }
}

/** Reject non-JSON data and bound work before serializing hostile frame input. */
export function widgetStateJson(value: unknown): string | null {
  let nodes = 0;
  let characters = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") { characters += item.length; return characters <= 16 * 1024; }
    if (typeof item !== "object") return false;
    if (Array.isArray(item)) return item.length <= 4096 && item.every((child) => visit(child, depth + 1));
    if (Object.prototype.toString.call(item) !== "[object Object]") return false;
    const keys = Object.keys(item);
    if (keys.length > 4096) return false;
    return keys.every((key) => { characters += key.length; return characters <= 16 * 1024 && visit((item as Record<string, unknown>)[key], depth + 1); });
  };
  try {
    if (!visit(value, 0)) return null;
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).length <= 16 * 1024 ? json : null;
  } catch { return null; }
}
export function reportArtifactStateError(reference: ResearchArtifactRef, error: string) { patch(reference, { error }); }
