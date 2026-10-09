import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchDraft } from "../types";
import {
  deleteResearchDraft,
  listResearchDrafts,
  reorderResearchDrafts,
  saveResearchDraft,
} from "../lib/api";
import { reorderedIds } from "../lib/researchFolders";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The scoped workspace's unsent drafts, in display order. Mutations apply
 * locally first; `research.drafts.changed` events refetch through `refresh`.
 * Results received after a workspace change are discarded. */
export function useResearchDrafts(workspaceId: string | null, onError: (message: string) => void) {
  const [drafts, setDrafts] = useState<ResearchDraft[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const requestSeqRef = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async (changedWorkspaceId?: string) => {
    const scope = workspaceIdRef.current;
    if (changedWorkspaceId !== undefined && changedWorkspaceId !== scope) return;
    const requestSeq = ++requestSeqRef.current;
    if (!scope) {
      setDrafts([]);
      return;
    }
    try {
      const next = await listResearchDrafts(scope);
      if (requestSeqRef.current === requestSeq) setDrafts(next);
    } catch {
      // Keep the Drafts tray empty if loading fails, including when an
      // older backend does not support the command.
      if (requestSeqRef.current === requestSeq) setDrafts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, workspaceId]);

  /** Creates (no id) or updates a draft in `workspaceId` (default: the
   * scoped workspace), so a save after a workspace switch still reaches the
   * draft's own workspace. An update to a draft no longer listed (sent or
   * deleted meanwhile) doesn't bring it back. Rejects with the backend's
   * message, which the caller shows where the draft is being edited. */
  const saveDraft = useCallback(
    async (
      id: string | null,
      prompt: string,
      workspaceId: string | null = workspaceIdRef.current,
    ): Promise<ResearchDraft> => {
      if (!workspaceId) throw new Error("Choose a research workspace first.");
      requestSeqRef.current += 1;
      const saved = await saveResearchDraft({ id, workspaceId, prompt });
      if (workspaceIdRef.current === workspaceId) {
        setDrafts((current) =>
          current.some((draft) => draft.id === saved.id)
            ? current.map((draft) => (draft.id === saved.id ? saved : draft))
            : id === null
              ? [saved, ...current]
              : current,
        );
      }
      return saved;
    },
    [],
  );

  /** Deletes the draft, then drops it from the list. Rejects with the
   * backend's message for the open draft to show, leaving the list as it
   * was. */
  const deleteDraft = useCallback(async (draftId: string): Promise<void> => {
    await deleteResearchDraft(draftId);
    requestSeqRef.current += 1;
    setDrafts((current) => current.filter((draft) => draft.id !== draftId));
  }, []);

  /** Removes the draft from the list at once; resolves true once it is
   * deleted. A failure is reported and the draft comes back. */
  const removeDraft = useCallback(async (draftId: string): Promise<boolean> => {
    const scope = workspaceIdRef.current;
    const previous = draftsRef.current;
    requestSeqRef.current += 1;
    setDrafts(previous.filter((draft) => draft.id !== draftId));
    try {
      await deleteResearchDraft(draftId);
      return true;
    } catch (err) {
      if (workspaceIdRef.current === scope) setDrafts(previous);
      onErrorRef.current(errorMessage(err));
      return false;
    }
  }, []);

  const moveDraft = useCallback(async (draftId: string, beforeId: string | null) => {
    const scope = workspaceIdRef.current;
    const previous = draftsRef.current;
    const ids = reorderedIds(
      previous.map((draft) => draft.id),
      draftId,
      beforeId,
    );
    if (!scope || ids.every((id, index) => previous[index]?.id === id)) return;
    const byId = new Map(previous.map((draft) => [draft.id, draft]));
    requestSeqRef.current += 1;
    setDrafts(ids.flatMap((id) => byId.get(id) ?? []));
    try {
      const next = await reorderResearchDrafts(scope, ids);
      if (workspaceIdRef.current === scope) setDrafts(next);
    } catch (err) {
      if (workspaceIdRef.current === scope) setDrafts(previous);
      onErrorRef.current(errorMessage(err));
    }
  }, []);

  return { drafts, refreshDrafts: refresh, saveDraft, removeDraft, deleteDraft, moveDraft };
}
