// Saved widget inputs on the client: the desktop's store
// (`@session/shared/lib/sessionArtifactState`) over the `artifacts.getState`
// and `artifacts.updateState` procedures, and the hook that connects one
// frame to it (the desktop's `useSessionArtifactState`).

import type { ResearchArtifactRef } from "@session/shared";
import {
  artifactStateKey,
  createArtifactStateStore,
  widgetStateJson,
} from "@session/shared/lib/sessionArtifactState";
import { useCallback, useEffect, useSyncExternalStore, type RefObject } from "react";

import { getResearchArtifactState, updateResearchArtifactState } from "../../api/api.js";

import type { WidgetFrameMessage } from "./widgetBridge.js";

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

function restoreMessage(reference: ResearchArtifactRef) {
  const config = readArtifactState(reference).config;
  return config
    ? { type: "session-widget-state-restore", value: config.enabled ? config.value : null }
    : null;
}

/**
 * Connects a widget frame to its revision's saved inputs. Returns the entry
 * and the handler for the frame's bridge messages. Restores when the page
 * loads, when the page says it is ready, and after a control action or the
 * first load replaced the stored inputs (`entry.restore`), never after the
 * widget's own saves: echoing a save back would reset inputs mid-typing.
 */
export function useArtifactState(
  reference: ResearchArtifactRef | null,
  frameRef: RefObject<HTMLIFrameElement | null>,
  frameUrl: string | null,
  loaded: boolean,
) {
  const entry = useSyncExternalStore(
    subscribeArtifactState,
    () => readArtifactState(reference),
    () => readArtifactState(null),
  );
  const key = reference ? artifactStateKey(reference) : null;
  // `key` names the reference; the object itself may be rebuilt per render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableReference = useCallback(() => reference, [key]);
  useEffect(() => {
    const current = stableReference();
    if (current) void loadArtifactState(current);
  }, [stableReference]);

  const post = useCallback(
    (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, "*"),
    [frameRef],
  );

  const onMessage = useCallback(
    (message: WidgetFrameMessage) => {
      const current = stableReference();
      if (!current || !frameUrl) return;
      if (message.type === "state-ready") {
        const restore = restoreMessage(current);
        if (restore) post(restore);
        return;
      }
      if (message.type !== "state-save") return;
      const state = readArtifactState(current);
      if (!state.config?.enabled || state.controlPending > 0) return;
      const json = widgetStateJson(message.value);
      if (json === null) {
        reportArtifactStateError(current, "Inputs must be JSON and fit within 16 KiB.");
        return;
      }
      stageArtifactInputs(current, json);
    },
    [stableReference, frameUrl, post],
  );

  // A frame that goes away (or changes page) flushes what it staged.
  useEffect(() => {
    const current = stableReference();
    if (!current || !frameUrl) return;
    return () => flushArtifactInputs(current);
  }, [stableReference, frameUrl]);

  const hasConfig = entry.config !== null;
  useEffect(() => {
    const current = stableReference();
    if (!loaded || !current) return;
    const restore = restoreMessage(current);
    if (restore) post(restore);
  }, [loaded, frameUrl, stableReference, hasConfig, entry.restore, post]);

  return { entry, onMessage };
}
