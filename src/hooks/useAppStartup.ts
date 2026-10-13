import { useEffect, useLayoutEffect, useRef } from "react";
import {
  getResearchInlineWidgets,
  getResearchLaunchInstruction,
  getRuntimeConfig,
  listAgents,
  listGroups,
  listRecentActivity,
  listResearchActivity,
  listResearchTrees,
  markAppWindowReady,
} from "../lib/api";
import { startAppStartup } from "../lib/appStartup";

async function loadInitial() {
  const [
    runtimeConfig,
    existingGroups,
    existingAgents,
    existingResearchTrees,
    existingResearchActivity,
    existingRecentActivity,
  ] = await Promise.all([
    getRuntimeConfig(),
    listGroups().catch(() => []),
    listAgents(),
    listResearchTrees(true).catch(() => []),
    listResearchActivity().catch(() => []),
    listRecentActivity().catch(() => ({ items: [], nextCursor: null })),
  ]);
  return {
    runtimeConfig,
    existingGroups,
    existingAgents,
    existingResearchTrees,
    existingResearchActivity,
    existingRecentActivity,
  };
}

// Preferences whose durable copy lives in the backend.
async function loadSecondary() {
  const [storedResearchLaunchInstruction, storedResearchInlineWidgets] = await Promise.all([
    getResearchLaunchInstruction().catch(() => null),
    getResearchInlineWidgets().catch(() => null),
  ]);
  return {
    storedResearchLaunchInstruction,
    storedResearchInlineWidgets,
  };
}

export function useAppStartup(handlers: {
  applyInitial: (
    snapshot: Awaited<ReturnType<typeof loadInitial>>,
    isCancelled: () => boolean,
  ) => Promise<void>;
  applySecondary: (snapshot: Awaited<ReturnType<typeof loadSecondary>>) => void;
  onError: (error: unknown) => void;
}): void {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  useEffect(
    () =>
      startAppStartup({
        loadInitial,
        loadSecondary,
        applyInitial: (snapshot, isCancelled) =>
          latest.current.applyInitial(snapshot, isCancelled),
        applySecondary: (snapshot) => latest.current.applySecondary(snapshot),
        onError: (error) => latest.current.onError(error),
        reveal: markAppWindowReady,
      }),
    [],
  );
}
