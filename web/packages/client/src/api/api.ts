// Desktop-named wrappers over the tRPC procedures (`03-api-and-events.md` §1).
//
// The desktop's `src/lib/api.ts` was one of the two seams against Rust;
// keeping its function names means a ported view calls the same thing it
// always called, and the only edit in the port is the import path. Inputs are
// the objects the router's zod schemas accept, which is where they differ from
// the desktop's positional Tauri arguments.
//
// Every function here is one procedure call. Cache effects live in
// `queries.ts`, not here, so a component that needs a raw call (an import
// flow, a retry outside React) is not forced through a hook.

import type {
  DocumentInfo,
  JournalEntry,
  RecentActivityCursor,
  RecentActivityPage,
  RecentActivityScope,
  RecentResearchQueryCursor,
  ResearchBranchRemoval,
  ResearchFolderState,
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchHighlightFeedItem,
  ResearchNode,
  ResearchNodeContent,
  ResearchRecapCandidate,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  Turn,
  UpdateResearchDocumentResult,
  User,
  UserSettings,
  Workspace,
} from "@session/shared";

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, trpc } from "./trpc.js";

/* -------------------------------------------------------------------------
 * system, auth, settings
 * ---------------------------------------------------------------------- */

export function getRuntimeConfig() {
  return trpc().system.runtimeConfig.query();
}

export function getMe(): Promise<User | null> {
  return trpc().auth.me.query();
}

export function logout() {
  return trpc().auth.logout.mutate();
}

/** Constructs the GitHub OAuth initiation URL. Invalid or untrusted return_to values are rejected on the server. */
export function gitHubSignInUrl(returnTo?: string, invite?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return_to", returnTo);
  if (invite) params.set("invite", invite);
  const query = params.toString();
  return `/auth/github${query === "" ? "" : `?${query}`}`;
}

/** Initiates full browser navigation to the GitHub OAuth endpoint. */
export function startGitHubSignIn(returnTo?: string, invite?: string): void {
  window.location.assign(gitHubSignInUrl(returnTo, invite));
}

export function getSettings() {
  return trpc().settings.get.query();
}

export interface SettingsUpdate {
  settings?: Partial<UserSettings>;
  researchLaunchInstruction?: string | null;
  defaultWorkspaceId?: string | null;
}

export function updateSettings(input: SettingsUpdate) {
  return trpc().settings.update.mutate(input);
}

export function getDraft(key: string) {
  return trpc().drafts.get.query({ key });
}

export function setDraft(key: string, value: string) {
  return trpc().drafts.set.mutate({ key, value });
}

export function getUsageSummary() {
  return trpc().usage.summary.query();
}

/* -------------------------------------------------------------------------
 * admin
 * ---------------------------------------------------------------------- */

export function listUsers() {
  return trpc().admin.listUsers.query();
}

export function setUserLimits(input: {
  userId: string;
  dailyTokens?: number | null;
  dailyRuns?: number | null;
}) {
  return trpc().admin.setLimits.mutate(input);
}

export function createInvites(count: number) {
  return trpc().admin.createInvites.mutate({ count });
}

/* -------------------------------------------------------------------------
 * workspaces and folders
 * ---------------------------------------------------------------------- */

export function listResearchWorkspaces() {
  return trpc().workspaces.list.query();
}

export function ensureDefaultResearchWorkspace(): Promise<Workspace> {
  return trpc().workspaces.ensureDefault.mutate();
}

export function createResearchWorkspace(name: string): Promise<Workspace> {
  return trpc().workspaces.create.mutate({ name });
}

export function renameResearchWorkspace(workspaceId: string, name: string): Promise<Workspace> {
  return trpc().workspaces.rename.mutate({ workspaceId, name });
}

export function removeResearchWorkspace(workspaceId: string) {
  return trpc().workspaces.remove.mutate({ workspaceId });
}

export function setDefaultResearchWorkspace(workspaceId: string): Promise<Workspace> {
  return trpc().workspaces.setDefault.mutate({ workspaceId });
}

export function reorderResearchWorkspaces(workspaceIds: string[]): Promise<Workspace[]> {
  return trpc().workspaces.reorder.mutate({ workspaceIds });
}

export function listResearchFolders(workspaceId: string): Promise<ResearchFolderState> {
  return trpc().folders.get.query({ workspaceId });
}

export function setResearchFolders(
  workspaceId: string,
  state: ResearchFolderState,
): Promise<ResearchFolderState> {
  return trpc().folders.set.mutate({ workspaceId, state });
}

/* -------------------------------------------------------------------------
 * research threads
 * ---------------------------------------------------------------------- */

export function listResearchTrees(input?: {
  workspaceId?: string;
  includeArchived?: boolean;
}): Promise<ResearchTreeSummary[]> {
  return trpc().research.listTrees.query(input);
}

export function reorderResearchTrees(input: {
  workspaceId: string;
  archived: boolean;
  treeIds: string[];
}) {
  return trpc().research.reorderTrees.mutate(input);
}

export function getResearchTree(treeId: string): Promise<ResearchTreeDetail> {
  return trpc().research.getTree.query({ treeId });
}

export function createResearchTree(request: {
  prompt: string;
  title?: string;
  model: string;
  workspaceId: string;
  documentIds?: string[];
}): Promise<ResearchTreeDetail> {
  return trpc().research.createTree.mutate(request);
}

export function forkResearchNode(request: {
  parentNodeId: string;
  prompt: string;
  model?: string;
  queryAnchor?: ResearchHighlightAnchor | null;
  inline?: boolean;
  documentIds?: string[];
}): Promise<ResearchNode> {
  return trpc().research.forkNode.mutate(request);
}

/** Relaunches a failed, cancelled or interrupted run in place: the node keeps
 * its id, resets to queued, and goes back through admission. Returns the
 * refreshed tree detail, as the desktop's command did. */
export function retryResearchNode(nodeId: string, model?: string): Promise<ResearchTreeDetail> {
  return trpc().research.retryNode.mutate(model === undefined ? { nodeId } : { nodeId, model });
}

export function cancelResearchNode(nodeId: string): Promise<ResearchNode> {
  return trpc().research.cancelNode.mutate({ nodeId });
}

export function renameResearchTree(treeId: string, title: string): Promise<ResearchTree> {
  return trpc().research.renameTree.mutate({ treeId, title });
}

export function renameResearchNode(nodeId: string, title: string): Promise<ResearchNode> {
  return trpc().research.renameNode.mutate({ nodeId, title });
}

export async function getResearchNodeContent(nodeId: string): Promise<ResearchNodeContent> {
  const content = await trpc().research.getNodeContent.query({ nodeId });
  // tRPC infers a procedure's output through its JSON-serialization type,
  // which drops the `unknown`-typed members of the passthrough blocks inside
  // `Turn` (`toolUse.input`, `toolResult.content`). The wire shape is the
  // shared one, so `turns` is restated — and only `turns`: every other field
  // stays checked against `ResearchNodeContent`, so one renamed or dropped on
  // the server is a compile error here rather than `undefined` at runtime.
  return { ...content, turns: content.turns as unknown as Turn[] };
}

export function updateResearchDocument(request: {
  nodeId: string;
  markdown: string;
  title?: string | null;
  expectedTitle: string;
  expectedResponseRevision: string;
  expectedHighlightIds?: string[];
}): Promise<UpdateResearchDocumentResult> {
  return trpc().research.updateDocument.mutate(request);
}

export function markResearchTreeViewed(treeId: string): Promise<ResearchTree> {
  return trpc().research.markTreeViewed.mutate({ treeId });
}

export function setResearchTreeFollowed(treeId: string, value: boolean): Promise<ResearchTree> {
  return trpc().research.setTreeFollowed.mutate({ treeId, value });
}

export function setResearchTreeBookmarked(treeId: string, value: boolean): Promise<ResearchTree> {
  return trpc().research.setTreeBookmarked.mutate({ treeId, value });
}

export function archiveResearchTree(treeId: string): Promise<ResearchTree> {
  return trpc().research.archiveTree.mutate({ treeId });
}

export function restoreResearchTree(treeId: string): Promise<ResearchTree> {
  return trpc().research.restoreTree.mutate({ treeId });
}

export function removeResearchTree(treeId: string) {
  return trpc().research.removeTree.mutate({ treeId });
}

export function removeResearchBranch(nodeId: string): Promise<ResearchBranchRemoval> {
  return trpc().research.removeBranch.mutate({ nodeId });
}

export function generateResearchAgentTitle(nodeId: string): Promise<string> {
  return trpc().research.generateTitle.mutate({ nodeId });
}

export function listResearchActivity(): Promise<ResearchNode[]> {
  return trpc().research.listActivity.query();
}

export function importResearchReport(request: {
  markdown: string;
  prompt: string;
  workspaceId: string;
}): Promise<ResearchTreeDetail> {
  return trpc().research.importReport.mutate(request);
}

/* -------------------------------------------------------------------------
 * highlights and recaps
 * ---------------------------------------------------------------------- */

export function createResearchHighlight(
  nodeId: string,
  anchor: ResearchHighlightAnchor,
): Promise<ResearchHighlight> {
  return trpc().highlights.create.mutate({ nodeId, anchor });
}

export function removeResearchHighlight(
  nodeId: string,
  highlightId: string,
): Promise<ResearchHighlight> {
  return trpc().highlights.remove.mutate({ nodeId, highlightId });
}

export function removeResearchHighlights(
  nodeId: string,
  highlightIds: string[],
): Promise<ResearchHighlight[]> {
  return trpc().highlights.removeMany.mutate({ nodeId, highlightIds });
}

export function listResearchHighlights(workspaceId?: string): Promise<ResearchHighlightFeedItem[]> {
  return trpc().highlights.listFeed.query(workspaceId === undefined ? undefined : { workspaceId });
}

export function getResearchRecapDefaultInstructions(): Promise<string> {
  return trpc().recaps.defaultInstructions.query();
}

export function generateResearchRecapCandidate(request: {
  nodeId: string;
  expectedResponseRevision: string;
  instructions: string;
}): Promise<ResearchRecapCandidate> {
  return trpc().recaps.generateCandidate.mutate(request);
}

export function applyResearchRecapCandidate(request: {
  nodeId: string;
  expectedResponseRevision: string;
  expectedCurrentRecapId?: string | null;
  candidate: ResearchRecapCandidate;
}): Promise<ResearchNode> {
  return trpc().recaps.applyCandidate.mutate(request);
}

/* -------------------------------------------------------------------------
 * feed and journal
 * ---------------------------------------------------------------------- */

export function listRecentActivity(input?: {
  scope?: RecentActivityScope;
  workspaceId?: string;
  limit?: number;
  before?: RecentActivityCursor | null;
  bookmarkedOnly?: boolean;
}): Promise<RecentActivityPage> {
  return trpc().feed.recentActivity.query(input);
}

export function listRecentResearchQueries(input?: {
  workspaceId?: string;
  limit?: number;
  before?: RecentResearchQueryCursor | null;
}) {
  return trpc().feed.recentQueries.query(input);
}

export function addJournalEntry(url: string): Promise<JournalEntry> {
  return trpc().journal.add.mutate({ url });
}

export function restoreJournalEntry(entry: JournalEntry): Promise<boolean> {
  return trpc().journal.restore.mutate({ entry });
}

export function updateJournalEntry(id: string, entry: JournalEntry): Promise<boolean> {
  return trpc().journal.update.mutate({ id, entry });
}

export function deleteJournalEntry(id: string): Promise<boolean> {
  return trpc().journal.remove.mutate({ id });
}

export function fetchJournalTweet(id: string, token: string): Promise<string> {
  return trpc().journal.fetchTweet.mutate({ id, token });
}

export function hydrateJournalTweet(entryId: string): Promise<JournalEntry> {
  return trpc().journal.hydrateTweet.mutate({ entryId });
}

/* -------------------------------------------------------------------------
 * documents and artifacts
 * ---------------------------------------------------------------------- */

export function listDocuments(workspaceId?: string): Promise<DocumentInfo[]> {
  return trpc().documents.list.query(workspaceId === undefined ? undefined : { workspaceId });
}

export function removeDocument(documentId: string) {
  return trpc().documents.remove.mutate({ documentId });
}

export function mintArtifactToken(documentId: string) {
  return trpc().artifacts.mintToken.mutate({ documentId });
}

/* -------------------------------------------------------------------------
 * events
 * ---------------------------------------------------------------------- */

export function setEventInterest(connectionId: string, nodeIds: string[]) {
  return trpc().events.setInterest.mutate({ connectionId, nodeIds });
}

/* -------------------------------------------------------------------------
 * uploads
 * ---------------------------------------------------------------------- */

export const UPLOADS_ENDPOINT = "/uploads";

export interface UploadProgress {
  /** Bytes the browser has handed to the socket so far. */
  loaded: number;
  total: number;
  /** 0..1, or null while the total is unknown. */
  fraction: number | null;
}

/**
 * `POST /uploads` (`03-api-and-events.md` §5). Uses multipart rather than tRPC
 * for binary payloads and XMLHttpRequest rather than fetch to report upload
 * progress.
 */
export function uploadDocuments(
  workspaceId: string,
  files: readonly File[],
  onProgress?: (progress: UploadProgress) => void,
): Promise<DocumentInfo[]> {
  const body = new FormData();
  body.set("workspaceId", workspaceId);
  for (const file of files) body.append("files", file);

  return new Promise<DocumentInfo[]>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", UPLOADS_ENDPOINT, true);
    request.withCredentials = true;
    request.setRequestHeader(REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE);
    request.responseType = "text";

    if (onProgress) {
      request.upload.addEventListener("progress", (event) => {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          fraction: event.lengthComputable && event.total > 0 ? event.loaded / event.total : null,
        });
      });
    }

    request.addEventListener("error", () => reject(new Error("the upload could not be sent")));
    request.addEventListener("abort", () => reject(new Error("the upload was cancelled")));
    request.addEventListener("load", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(request.responseText) as unknown;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300 && Array.isArray(parsed)) {
        resolve(parsed as DocumentInfo[]);
        return;
      }
      // Server upload errors return an { error } payload containing the filename and failure reason.
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>)["error"] === "string"
          ? ((parsed as Record<string, unknown>)["error"] as string)
          : `the upload failed (${request.status})`;
      reject(new Error(message));
    });

    request.send(body);
  });
}
