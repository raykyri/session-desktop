// Mutations issued only from an open thread (`09-research-document-view.md`
// §4). The thread-level ones the sidebar and Home also use (fork, ask, cancel,
// retry, rename, remove) are in `api/queries.ts`.
//
// The cache rule is the one in 07 §4.1: a mutation writes what the server
// returned, and the `research.*` event it causes finds that work done.
// Highlight edits are confirmed writes rather than optimistic ones: a passage
// is painted under its stored id, so a provisional highlight would stack with
// the one the `research.highlight.created` event brings.

import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchTreeDetail,
} from "@session/shared";
import { patchResearchDetailNode } from "@session/shared/lib/researchEvents";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  createResearchHighlight,
  removeResearchHighlights,
  rerunResearchNode,
  setResearchChainOrder,
  updateResearchDocument,
} from "../../api/api.js";
import { invalidateKeys, patchDetail } from "../../api/cache.js";
import { queryKeys } from "../../api/queries.js";

import type { HighlightActions } from "./useTextSelection.js";

/** Replaces one cached node's highlight list. */
export function patchNodeHighlights(
  client: QueryClient,
  treeId: string,
  nodeId: string,
  transform: (highlights: ResearchHighlight[]) => ResearchHighlight[],
): void {
  client.setQueryData<ResearchTreeDetail>(queryKeys.tree(treeId), (detail) => {
    if (!detail) return detail;
    const index = detail.nodes.findIndex((node) => node.id === nodeId);
    if (index === -1) return detail;
    const node = detail.nodes[index] as ResearchNode;
    const nodes = [...detail.nodes];
    nodes[index] = { ...node, highlights: transform(node.highlights) };
    return { ...detail, nodes };
  });
}

export function useHighlightMutations(treeId: string): HighlightActions {
  const client = useQueryClient();
  const create = useCallback(
    async (nodeId: string, anchor: ResearchHighlightAnchor) => {
      const created = await createResearchHighlight(nodeId, anchor);
      patchNodeHighlights(client, treeId, nodeId, (highlights) => [...highlights, created]);
    },
    [client, treeId],
  );
  const remove = useCallback(
    async (nodeId: string, highlightIds: string[]) => {
      const removed = await removeResearchHighlights(nodeId, highlightIds);
      const removedIds = new Set(removed.map(({ id }) => id));
      patchNodeHighlights(client, treeId, nodeId, (highlights) =>
        highlights.filter(({ id }) => !removedIds.has(id)),
      );
    },
    [client, treeId],
  );
  // Creation goes first: if the removal then fails, the reader is left with
  // overlapping highlights rather than none.
  const expand = useCallback(
    async (nodeId: string, anchor: ResearchHighlightAnchor, absorbed: string[]) => {
      const created = await createResearchHighlight(nodeId, anchor);
      const removed = absorbed.length > 0 ? await removeResearchHighlights(nodeId, absorbed) : [];
      const removedIds = new Set(removed.map(({ id }) => id));
      patchNodeHighlights(client, treeId, nodeId, (highlights) => [
        ...highlights.filter(({ id }) => !removedIds.has(id)),
        created,
      ]);
    },
    [client, treeId],
  );
  return { create, remove, expand };
}

/** Writes a node the server returned into the cached detail. */
function writeNode(client: QueryClient, node: ResearchNode): void {
  patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
}

export function useUpdateResearchDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateResearchDocument,
    onSuccess: (result) => {
      client.setQueryData<ResearchTreeDetail>(queryKeys.tree(result.tree.id), (detail) =>
        detail
          ? {
              ...detail,
              tree: result.tree,
              nodes: detail.nodes.map((node) => (node.id === result.node.id ? result.node : node)),
            }
          : detail,
      );
      // The snapshot was replaced; the content query produces the new one.
      void client.invalidateQueries({ queryKey: queryKeys.nodeContent(result.node.id) });
    },
  });
}

/** Reruns a settled question in place; the server answers with the detail. */
export function useRerunResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: rerunResearchNode,
    onSuccess: (detail, nodeId) => {
      client.setQueryData(queryKeys.tree(detail.tree.id), detail);
      // The rerun starts a fresh attempt from sequence zero.
      invalidateKeys(client, queryKeys.nodeContent(nodeId));
    },
  });
}

/** Stores a chain's display order. The cached head takes the order at once
 * and goes back to the stored one if the server refuses it. */
export function useSetChainOrder(treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { headNodeId: string; nodeIds: string[] }) =>
      setResearchChainOrder(input.headNodeId, input.nodeIds),
    onMutate: (input) => {
      const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree(treeId));
      const previous = detail?.nodes.find((node) => node.id === input.headNodeId)?.chainOrder;
      patchDetail(client, treeId, (current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === input.headNodeId ? { ...node, chainOrder: input.nodeIds } : node,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, input, context) => {
      patchDetail(client, treeId, (current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === input.headNodeId ? { ...node, chainOrder: context?.previous } : node,
              ),
            }
          : current,
      );
    },
    onSuccess: (node) => writeNode(client, node),
  });
}
