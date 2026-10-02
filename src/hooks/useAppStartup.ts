import { useEffect, useLayoutEffect, useRef } from "react";
import {
  getAgentDraft,
  getOpenRouterKey,
  getPaneSplits,
  getResearchLaunchInstruction,
  getRuntimeConfig,
  getUseLoginShell,
  getWorktreeLocation,
  listAgents,
  listAgentTurnQueue,
  listGroups,
  listPanes,
  listRecentActivity,
  listResearchActivity,
  listResearchFolders,
  listResearchTrees,
  markAppWindowReady,
} from "../lib/api";
import { startAppStartup } from "../lib/appStartup";
import { emptyResearchFolderState } from "../lib/researchFolders";

async function loadInitial() {
  const [
    runtimeConfig,
    existingGroups,
    existingPanes,
    existingPaneSplits,
    existingAgents,
    existingResearchTrees,
    existingResearchActivity,
    existingRecentActivity,
    existingResearchFolders,
  ] = await Promise.all([
    getRuntimeConfig(),
    listGroups().catch(() => []),
    listPanes(),
    getPaneSplits().catch(() => []),
    listAgents(),
    listResearchTrees(true).catch(() => []),
    listResearchActivity().catch(() => []),
    listRecentActivity().catch(() => ({ items: [], nextCursor: null })),
    listResearchFolders().catch(emptyResearchFolderState),
  ]);
  return {
    runtimeConfig,
    existingGroups,
    existingPanes,
    existingPaneSplits,
    existingAgents,
    existingResearchTrees,
    existingResearchActivity,
    existingRecentActivity,
    existingResearchFolders,
  };
}

async function loadSecondary({
  existingAgents,
}: Awaited<ReturnType<typeof loadInitial>>) {
  // Fetch only lightweight per-agent state. Visible surfaces own transcript hydration.
  const [
    storedOpenRouterKey,
    storedUseLoginShell,
    storedWorktreeLocation,
    storedResearchLaunchInstruction,
    queueEntries,
    draftEntries,
  ] = await Promise.all([
    getOpenRouterKey().catch(() => ""),
    getUseLoginShell().catch(() => null),
    getWorktreeLocation().catch(() => null),
    getResearchLaunchInstruction().catch(() => null),
    Promise.all(
      existingAgents.map(
        async (agent) =>
          [
            agent.id,
            await listAgentTurnQueue(agent.id).catch(() => []),
          ] as const,
      ),
    ),
    Promise.all(
      existingAgents.map(
        async (agent) =>
          [agent.id, await getAgentDraft(agent.id).catch(() => null)] as const,
      ),
    ),
  ]);
  return {
    storedOpenRouterKey,
    storedUseLoginShell,
    storedWorktreeLocation,
    storedResearchLaunchInstruction,
    queueEntries,
    draftEntries,
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
