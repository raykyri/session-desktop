import type { ResearchFolder, ResearchTreeSummary } from "../types";

/** A row of the Trash: a tree (question, note, link or document) or a folder. */
export type ResearchTrashEntry =
  | { kind: "tree"; id: string; title: string; trashedAt: number; tree: ResearchTreeSummary }
  | { kind: "folder"; id: string; title: string; trashedAt: number; folder: ResearchFolder };

/** The Trash of one workspace, most recently trashed first: its trees from
 * listResearchTrash (every workspace) and its trashed folders. */
export function researchTrashEntries(
  trees: readonly ResearchTreeSummary[],
  folders: readonly ResearchFolder[],
  workspaceId: string | null,
): ResearchTrashEntry[] {
  if (!workspaceId) return [];
  const entries: ResearchTrashEntry[] = [
    ...trees
      .filter((tree) => tree.workspaceId === workspaceId && tree.trashedAt != null)
      .map((tree): ResearchTrashEntry => ({
        kind: "tree",
        id: tree.id,
        title: tree.title,
        trashedAt: tree.trashedAt ?? 0,
        tree,
      })),
    ...folders
      .filter((folder) => folder.workspaceId === workspaceId && folder.trashedAt != null)
      .map((folder): ResearchTrashEntry => ({
        kind: "folder",
        id: folder.id,
        title: folder.name,
        trashedAt: folder.trashedAt ?? 0,
        folder,
      })),
  ];
  return entries.sort(
    (left, right) => right.trashedAt - left.trashedAt || left.id.localeCompare(right.id),
  );
}

/** "1 item", "3 items". */
export function researchTrashCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

/** The first delete confirmation's sentence for a thread: what moves to the
 * Trash with it. */
export function researchTrashTreeSentence(followUpCount: number | null): string {
  if (followUpCount == null || followUpCount === 0) {
    return "It moves to the Trash, where you can restore it.";
  }
  return `It moves to the Trash with its ${followUpCount} follow-up${
    followUpCount === 1 ? "" : "s"
  }, where you can restore it.`;
}

/** The first delete confirmation's sentence for a folder. Its questions are
 * not trashed; they show in Unfiled until the folder is restored. */
export function researchTrashFolderSentence(questionCount: number): string {
  if (questionCount === 0) return "The folder is empty. It moves to the Trash.";
  return `The folder moves to the Trash. Its ${questionCount} question${
    questionCount === 1 ? "" : "s"
  } show${questionCount === 1 ? "s" : ""} in Unfiled until you restore it.`;
}
