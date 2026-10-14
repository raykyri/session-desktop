import { getResearchArtifactState, updateResearchArtifactState, type ResearchArtifactRef } from "./api";
import { artifactStateKey, createArtifactStateStore } from "@session/shared/lib/sessionArtifactState";

// The saved-input store (web/packages/shared/src/lib/sessionArtifactState.ts)
// over the desktop's artifact state commands.
export { artifactStateKey, widgetStateJson, type ArtifactStateEntry } from "@session/shared/lib/sessionArtifactState";

export const {
  readArtifactState,
  subscribeArtifactState,
  loadArtifactState,
  changeArtifactState,
  stageArtifactInputs,
  flushArtifactInputs,
  reportArtifactStateError,
} = createArtifactStateStore({
  get: (reference) => getResearchArtifactState(reference),
  update: (reference, action, value) => updateResearchArtifactState(reference, action, value),
});

const references = new Map<string, ResearchArtifactRef>();
const handles = new Map<string, string>();

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
