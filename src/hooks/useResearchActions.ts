import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import type { ResearchData } from "./useResearchData";
import type { ResearchNavigation } from "./useResearchNavigation";
import type { PostActions } from "../components/research/ResearchPost";
import { adapterCanLaunchResearch, adapterReadinessMessage } from "../lib/adapterReadiness";
import { upsertRecentActivityResearchNode } from "../lib/activity";
import {
  cancelResearchNode,
  createResearchPost,
  createResearchPostFollowUp,
  createResearchTree,
  ensureDefaultResearchWorkspace,
  forkResearchNode,
  generateResearchAgentTitle,
  getResearchTree,
  importResearchReport,
  removeResearchBranch,
  removeResearchTree,
  renameResearchNode,
  renameResearchTree,
  rerunResearchNode,
  restoreResearchTree,
  retryResearchNode,
  updateResearchDocument,
  updateResearchPost,
} from "../lib/api";
import { reconcileResearchTreeDetail } from "../lib/researchSnapshots";
import type { ResearchWorkspaceScope } from "../lib/researchScope";
import type { GroupInfo, NodeAnchor, ResearchTreeDetail, RuntimeConfig } from "../types";

interface ResearchActionContext {
  groups: GroupInfo[];
  setGroups: Dispatch<SetStateAction<GroupInfo[]>>;
  config: RuntimeConfig | null;
  /** The sidebar workspace that receives an imported report. */
  researchScope: ResearchWorkspaceScope;
  /** Probes the adapters (re-probing with `force`) and returns them. */
  refreshAdapterReadiness: (options?: { force?: boolean }) => Promise<RuntimeConfig["adapters"]>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * The research commands the composers, the thread page, the feed and the
 * tree menus run: launching research, notes and imports, edits, follow-ups,
 * retries, renames, restore and removal. Results the backend returns are
 * applied to the open tree's detail; the session events that follow update
 * everything else.
 */
export function useResearchActions(
  data: ResearchData,
  navigation: ResearchNavigation,
  {
    groups,
    setGroups,
    config,
    researchScope,
    refreshAdapterReadiness,
    setError,
  }: ResearchActionContext,
) {
  const {
    setRecentActivityItems,
    recentActivityItemsRef,
    activeResearchTreeIdRef,
    setActiveResearchDetail,
  } = data;
  const {
    refreshResearchNavigation,
    focusResearchHome,
    pruneResearchTreeVisits,
    adoptCreatedResearchTree,
  } = navigation;
  // Research titles use a fresh, tool-free request through the run's own
  // adapter/model. Automatic failures stay silent: the prompt-derived title
  // is already visible, and title metadata must never fail the research run.
  const generateResearchTitle = useCallback(async (nodeId: string): Promise<string | null> => {
    try {
      return await generateResearchAgentTitle(nodeId);
    } catch {
      return null;
    }
  }, []);
  const applyGeneratedResearchTreeTitle = useCallback(
    async (treeId: string, nodeId: string, originalTitle: string) => {
      const title = await generateResearchTitle(nodeId);
      if (!title || title === originalTitle) {
        return;
      }
      try {
        // Generation spans a network/model round trip; skip if the user
        // renamed the tree in the meantime.
        const current = await getResearchTree(treeId);
        if (current.tree.title !== originalTitle) {
          return;
        }
        await renameResearchTree(treeId, title);
      } catch {
        return;
      }
    },
    [generateResearchTitle],
  );
  const applyGeneratedResearchNodeTitle = useCallback(
    async (treeId: string, nodeId: string) => {
      const title = await generateResearchTitle(nodeId);
      if (!title) {
        return;
      }
      try {
        // Follow-up title generation is asynchronous too. Preserve a title the
        // user supplied while this model request was in flight.
        const current = await getResearchTree(treeId);
        if (current.nodes.find((node) => node.id === nodeId)?.title) {
          return;
        }
        await renameResearchNode(nodeId, title);
      } catch {
        return;
      }
    },
    [generateResearchTitle],
  );
  // Shared by the research and document composers: use the selected folder or
  // create the default folder on first use.
  const resolveResearchComposerWorkspace = useCallback(
    async (workspaceId: string | null): Promise<GroupInfo> => {
      const group = workspaceId
        ? groups.find((candidate) => candidate.id === workspaceId)
        : await ensureDefaultResearchWorkspace();
      if (!group || group.scope !== "research") {
        throw new Error("The selected research workspace is no longer available.");
      }
      setGroups((current) =>
        current.some((candidate) => candidate.id === group.id) ? current : [...current, group],
      );
      return group;
    },
    [groups],
  );
  const submitNewResearch = useCallback(
    async (input: {
      prompt: string;
      adapter: string;
      model: string | null;
      effort: string | null;
      workspaceId: string | null;
    }) => {
      const probedAdapters = await refreshAdapterReadiness();
      const selectedAdapter = probedAdapters.find(
        (adapter) => adapter.id === input.adapter,
      );
      if (!adapterCanLaunchResearch(selectedAdapter)) {
        throw new Error(
          selectedAdapter
            ? adapterReadinessMessage(selectedAdapter)
            : "The selected research agent is no longer available.",
        );
      }
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      let detail: ResearchTreeDetail;
      try {
        detail = await createResearchTree({
          prompt: input.prompt,
          adapter: input.adapter,
          model: input.model,
          effort: input.effort,
          workspaceId: group.id,
        });
      } catch (err) {
        // The Home composer displays the rethrown error beside the retained fields.
        void refreshResearchNavigation().catch(() => undefined);
        void refreshAdapterReadiness({ force: true }).catch(() => undefined);
        throw err;
      }
      adoptCreatedResearchTree(detail);
      void applyGeneratedResearchTreeTitle(
        detail.tree.id,
        detail.tree.rootNodeId,
        detail.tree.title,
      );
      return detail.tree.id;
    },
    [
      adoptCreatedResearchTree,
      applyGeneratedResearchTreeTitle,
      refreshResearchNavigation,
      refreshAdapterReadiness,
      resolveResearchComposerWorkspace,
    ],
  );
  // A note stays on Home: the feed shows it at the top, unlike a research
  // launch, which opens its thread.
  const submitNewPost = useCallback(
    async (input: {
      body: string;
      adapter: string;
      model: string | null;
      effort: string | null;
      workspaceId: string | null;
    }) => {
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      const detail = await createResearchPost({ ...input, workspaceId: group.id });
      const root = detail.nodes.find((node) => node.id === detail.tree.rootNodeId);
      if (root) {
        setRecentActivityItems((current) => {
          const next = upsertRecentActivityResearchNode(current, root);
          recentActivityItemsRef.current = next;
          return next;
        });
      }
      return detail.tree.id;
    },
    [resolveResearchComposerWorkspace],
  );
  const importReport = useCallback(async (markdown: string, prompt: string) => {
    const group = await resolveResearchComposerWorkspace(researchScope);
    const available = config?.adapters.filter(
      (candidate) => candidate.supportsRecapGeneration && adapterCanLaunchResearch(candidate),
    ) ?? [];
    const adapter = available.find((candidate) => candidate.default) ?? available[0];
    const detail = await importResearchReport({
      markdown,
      prompt,
      workspaceId: group.id,
      adapter: adapter?.id ?? "",
    });
    adoptCreatedResearchTree(detail);
  }, [config, researchScope, resolveResearchComposerWorkspace, adoptCreatedResearchTree]);

  const editResearchDocument = useCallback(
    async (input: {
      nodeId: string;
      markdown: string;
      title: string | null;
      expectedResponseRevision: string;
      expectedTitle: string;
      expectedHighlightIds: string[];
    }) => {
      const result = await updateResearchDocument(input);
      if (activeResearchTreeIdRef.current === result.tree.id) {
        // Apply the authoritative metadata immediately. The thread page
        // separately refetches the body when its snapshot revision changed.
        setActiveResearchDetail((current) =>
          current?.tree.id === result.tree.id
            ? {
                tree: result.tree,
                nodes: current.nodes.map((node) =>
                  node.id === result.node.id ? result.node : node,
                ),
              }
            : current,
        );
      }
      return result;
    },
    [],
  );
  const editResearchPost = useCallback(
    async (input: { nodeId: string; text: string; expectedText: string }) => {
      const result = await updateResearchPost(input);
      if (activeResearchTreeIdRef.current === result.tree.id) {
        setActiveResearchDetail((current) =>
          current?.tree.id === result.tree.id
            ? {
                tree: result.tree,
                nodes: current.nodes.map((node) => (node.id === result.node.id ? result.node : node)),
              }
            : current,
        );
      }
      return result;
    },
    [],
  );
  const cancelResearchRun = useCallback(
    async (nodeId: string) => {
      await cancelResearchNode(nodeId);
    },
    [],
  );
  // Rejects with the backend's message: the rename dialogs stay open with the
  // typed title and show it.
  const renameResearchTreeTitle = useCallback(async (treeId: string, title: string) => {
    await renameResearchTree(treeId, title);
  }, []);
  // Unarchiving leaves the selection alone, so several threads can be
  // restored from the Archived list in a row; an open thread stays open.
  const restoreResearchTreeFromMenu = useCallback(async (treeId: string) => {
    try {
      await restoreResearchTree(treeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  // Every delete entry point (thread menus, feed menus) reconciles the active
  // thread the same way: the deleted thread closes back to the feed.
  const removeResearchTreeAndSelectFallback = useCallback(
    async (treeId: string) => {
      setError(null);
      await removeResearchTree(treeId);
      if (activeResearchTreeIdRef.current === treeId) {
        focusResearchHome();
      }
      pruneResearchTreeVisits((id) => id !== treeId);
    },
    [focusResearchHome, pruneResearchTreeVisits],
  );
  const removeResearchTreeFromMenu = useCallback(
    async (treeId: string) => {
      setError(null);
      try {
        await removeResearchTreeAndSelectFallback(treeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [removeResearchTreeAndSelectFallback],
  );
  const createResearchFollowup = useCallback(
    async (
      parentNodeId: string,
      prompt: string,
      anchor?: NodeAnchor | null,
      inline?: boolean,
      replacesNodeId?: string | null,
    ) => {
      const node = await forkResearchNode(
        parentNodeId,
        prompt,
        anchor,
        inline ?? false,
        replacesNodeId,
      );
      void applyGeneratedResearchNodeTitle(node.treeId, node.id);
      return node;
    },
    [applyGeneratedResearchNodeTitle],
  );
  const retryResearchRun = useCallback(
    async (nodeId: string) => {
      // The command settles the whole relaunch (reset + spawn/fork + bind)
      // before returning the refreshed tree, so reconciling it here is
      // authoritative; interleaved research.node.updated events carry the
      // same node states and reconcile idempotently.
      const detail = await retryResearchNode(nodeId);
      if (activeResearchTreeIdRef.current === detail.tree.id) {
        setActiveResearchDetail((current) =>
          reconcileResearchTreeDetail(current, detail),
        );
      }
    },
    [],
  );
  // As retryResearchRun, for a rerun that may replace a complete answer.
  const rerunResearchRun = useCallback(async (nodeId: string) => {
    const detail = await rerunResearchNode(nodeId);
    if (activeResearchTreeIdRef.current === detail.tree.id) {
      setActiveResearchDetail((current) => reconcileResearchTreeDetail(current, detail));
    }
  }, []);
  // Follow-ups and retries under notes, in a note's follow-ups column. The
  // resulting node events update the feed and the open thread, so nothing is
  // patched here.
  const postActions = useMemo<PostActions>(
    () => ({
      onAskFollowUp: async ({ parentNodeId, prompt, asNote }) => {
        if (asNote) {
          await createResearchPostFollowUp(parentNodeId, prompt);
          return;
        }
        await createResearchFollowup(parentNodeId, prompt, null, false);
      },
      onRetry: retryResearchRun,
    }),
    [createResearchFollowup, retryResearchRun],
  );
  const removeResearchBranchFromThread = useCallback(
    async (nodeId: string) => {
      setError(null);
      const removal = await removeResearchBranch(nodeId);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId === removal.treeId) {
        // The delete already committed. Prune the live detail immediately;
        // the structural event follows with a targeted authoritative tree
        // reconciliation for counts and activity.
        const removedNodeIds = new Set(removal.removedNodeIds);
        setActiveResearchDetail((current) =>
          current?.tree.id === removal.treeId
            ? {
                ...current,
                nodes: current.nodes.filter((node) => !removedNodeIds.has(node.id)),
              }
            : current,
        );
      }
      return removal;
    },
    [],
  );

  return {
    submitNewResearch,
    submitNewPost,
    importReport,
    editResearchDocument,
    editResearchPost,
    cancelResearchRun,
    renameResearchTreeTitle,
    restoreResearchTreeFromMenu,
    removeResearchTreeAndSelectFallback,
    removeResearchTreeFromMenu,
    createResearchFollowup,
    retryResearchRun,
    rerunResearchRun,
    postActions,
    removeResearchBranchFromThread,
  };
}
