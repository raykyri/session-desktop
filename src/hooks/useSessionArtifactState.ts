import { useEffect, useSyncExternalStore, type RefObject } from "react";
import type { ResearchArtifactRef } from "../lib/api";
import { artifactStateKey, flushArtifactInputs, stageArtifactInputs, loadArtifactState, readArtifactState, reportArtifactStateError, subscribeArtifactState, widgetStateJson } from "../lib/sessionArtifactState";

export function useSessionArtifactState(reference: ResearchArtifactRef | null, frameRef: RefObject<HTMLIFrameElement | null>, frameUrl: string | null, loaded: boolean) {
  const entry = useSyncExternalStore(subscribeArtifactState, () => readArtifactState(reference), () => readArtifactState(null));
  const key = reference ? artifactStateKey(reference) : null;
  useEffect(() => { if (reference) void loadArtifactState(reference); }, [key]);
  useEffect(() => {
    if (!reference || !frameUrl) return;
    const restore = () => {
      const config = readArtifactState(reference).config;
      if (config) frameRef.current?.contentWindow?.postMessage({ type: "session-widget-state-restore", value: config.enabled ? config.value : null }, "*");
    };
    const receive = (event: MessageEvent) => {
      const ownWindow = frameRef.current?.contentWindow;
      if (!ownWindow || event.source !== ownWindow || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "session-widget-state-ready") { restore(); return; }
      if (event.data.type !== "session-widget-state-save" || !readArtifactState(reference).config?.enabled) return;
      if (readArtifactState(reference).controlPending > 0) return;
      const json = widgetStateJson(event.data.value);
      if (json === null) { reportArtifactStateError(reference, "Inputs must be JSON and fit within 16 KiB."); return; }
      stageArtifactInputs(reference, json);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      flushArtifactInputs(reference);
    };
  }, [key, frameUrl, frameRef]);
  useEffect(() => {
    if (!loaded || !entry.config) return;
    frameRef.current?.contentWindow?.postMessage({ type: "session-widget-state-restore", value: entry.config.enabled ? entry.config.value : null }, "*");
  }, [loaded, frameUrl, frameRef, entry.config]);
  return entry;
}
