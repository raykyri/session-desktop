// The mutations the document view owns and no other surface needs
// (`09-research-document-view.md` §4).
//
// The thread-level mutations (fork, cancel, retry, rename, remove, follow,
// bookmark, mark-viewed) live in `api/queries.ts` because the sidebar and Home
// call them too. Highlights, document edits and recaps are only ever issued
// from an open document, so they live beside it.
//
// The cache rule is the one in 07 §4.1: a mutation writes what the server
// returned, and the `research.*` event it causes finds that work already done.
// Highlight edits are confirmed writes rather than optimistic ones: a passage
// is painted from its stored id, so a provisional highlight would be painted
// under an id the `research.highlight.created` event does not carry, and the
// two would briefly stack over the same words in the overlap layer. The round
// trip is one call and the paint follows it within a frame.

import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchTreeDetail,
} from "@session/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  createResearchHighlight,
  removeResearchHighlights,
  updateResearchDocument,
} from "../../api/api.js";
import { queryKeys } from "../../api/queries.js";

/** Replaces one cached node's highlight list, leaving every other node's
 * identity alone so their segments keep their memo. */
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

export interface HighlightMutations {
  /** Saves one passage. */
  create: (nodeId: string, anchor: ResearchHighlightAnchor) => Promise<void>;
  /** Retires every annotation the selection covered. */
  remove: (nodeId: string, highlightIds: string[]) => Promise<void>;
  /** Saves the merged annotation, then retires the ones it absorbed. Creation
   * goes first on purpose: if the removal then fails the reader is left with
   * overlapping highlights rather than none. */
  expand: (nodeId: string, anchor: ResearchHighlightAnchor, absorbed: string[]) => Promise<void>;
}

export function useHighlightMutations(treeId: string): HighlightMutations {
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

export function useUpdateResearchDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateResearchDocument,
    onSuccess: (result) => {
      client.setQueryData<ResearchTreeDetail>(queryKeys.tree(result.tree.id), (detail) => {
        if (!detail) return detail;
        return {
          tree: result.tree,
          nodes: detail.nodes.map((node) => (node.id === result.node.id ? result.node : node)),
        };
      });
      // The snapshot was replaced atomically, so the displayed revision is
      // stale the moment this returns; the node's content query is the only
      // thing that can produce the new one.
      void client.invalidateQueries({ queryKey: queryKeys.nodeContent(result.node.id) });
    },
  });
}
