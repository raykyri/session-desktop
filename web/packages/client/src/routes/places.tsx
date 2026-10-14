// The place views (`10-home-feed-journal.md` §1): a folder (`/f/$folderId`),
// Drafts (`/drafts`) and one draft (`/drafts/$draftId`), Archive
// (`/archive`) and Trash (`/trash`). A folder and Drafts end with the ask
// box, and what it creates is filed there.

import { RESEARCH_DRAFTS_FOLDER_ID } from "@session/shared/lib/researchFolders";
import { useParams } from "@tanstack/react-router";

import { useResearchDrafts } from "../api/queries.js";
import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { DraftView } from "../features/drafts/DraftView.js";
import { FeedView } from "../features/home/FeedView.js";
import { useFiling } from "../features/home/useFiling.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";
import { QueryState } from "../ui/QueryState.js";

/** The ask box of a place view: what it creates is filed in `place`. */
function PlaceComposer({ workspaceId, place }: { workspaceId: string; place: string }) {
  const filing = useFiling(workspaceId);
  return (
    <ResearchQueryComposer
      workspaceId={workspaceId}
      onCreated={(detail) => filing.fileNewTree(detail.tree.id, place)}
    />
  );
}

export function FolderPage() {
  const { folderId } = useParams({ from: "/_shell/f/$folderId" });
  const { workspaceId } = useWorkspaceScope();
  if (workspaceId === "") return null;
  return (
    <FeedView
      key={`${workspaceId}:${folderId}`}
      view={{ kind: "folder", folderId }}
      workspaceId={workspaceId}
      composer={<PlaceComposer workspaceId={workspaceId} place={folderId} />}
    />
  );
}

export function DraftsPage() {
  const { workspaceId } = useWorkspaceScope();
  if (workspaceId === "") return null;
  return (
    <FeedView
      key={workspaceId}
      view={{ kind: "drafts" }}
      workspaceId={workspaceId}
      composer={<PlaceComposer workspaceId={workspaceId} place={RESEARCH_DRAFTS_FOLDER_ID} />}
    />
  );
}

export function DraftPage() {
  const { draftId } = useParams({ from: "/_shell/drafts/$draftId" });
  const { workspaceId } = useWorkspaceScope();
  const drafts = useResearchDrafts(workspaceId);
  const draft = drafts.data?.find((candidate) => candidate.id === draftId);
  if (draft) return <DraftView key={draft.id} draft={draft} workspaceId={workspaceId} />;
  if (drafts.isError) {
    return <QueryState error="Couldn’t load drafts." onRetry={() => void drafts.refetch()} />;
  }
  if (drafts.isSuccess) return <QueryState empty="This draft was sent or deleted." />;
  return null;
}

export function ArchivePage() {
  const { workspaceId } = useWorkspaceScope();
  if (workspaceId === "") return null;
  return <FeedView key={workspaceId} view={{ kind: "archive" }} workspaceId={workspaceId} />;
}

export function TrashPage() {
  const { workspaceId } = useWorkspaceScope();
  if (workspaceId === "") return null;
  return <FeedView key={workspaceId} view={{ kind: "trash" }} workspaceId={workspaceId} />;
}
