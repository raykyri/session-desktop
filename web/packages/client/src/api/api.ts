// Desktop-named wrappers over the tRPC procedures (`03-api-and-events.md` §1).
//
// The desktop's `src/lib/api.ts` was one of the two integration points with Rust;
// keeping its function names means a ported view calls the same thing it
// always called, and the only edit in the port is the import path. Inputs are
// the objects the router's zod schemas accept, which is where they differ from
// the desktop's positional Tauri arguments.
//
// Every function here is one procedure call. Cache effects live in
// `queries.ts`, not here, so a component that needs a raw call (an import
// flow, a retry outside React) is not forced through a hook.

import type {
  ArtifactStateAction,
  NodeAnchor,
  RecentActivityCursor,
  RecentActivityPage,
  RecentActivityScope,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchArtifactRef,
  ResearchArtifactRevision,
  ResearchArtifactState,
  ResearchBranchRemoval,
  ResearchDraft,
  ResearchFolderState,
  ResearchImageAttachment,
  ResearchFollowupQueueItem,
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
  UpdateResearchPostResult,
  User,
  UserSettings,
  Workspace,
} from "@session/shared";
import { RESEARCH_IMAGE_UPLOAD_PATH } from "@session/shared";

import { REQUESTED_WITH_HEADERS, trpc } from "./trpc.js";

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
  return trpc().interfaceDrafts.get.query({ key });
}

export function setDraft(key: string, value: string) {
  return trpc().interfaceDrafts.set.mutate({ key, value });
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
  /** An effort the model accepts; absent or null, the model's default. */
  effort?: string | null;
  workspaceId: string;
  /** Ids from `uploadResearchImage`. */
  images?: string[];
}): Promise<ResearchTreeDetail> {
  return trpc().research.createTree.mutate(request);
}

/* -------------------------------------------------------------------------
 * posts: notes and saved links
 * ---------------------------------------------------------------------- */

/** Saves a note, or a link when the body is a single http(s) URL
 * (`create_research_post`). `model` and `effort` are the default for the
 * note's AI follow-ups; nothing runs. */
export function createResearchPost(request: {
  body: string;
  workspaceId: string;
  model: string;
  effort?: string | null;
  images?: string[];
}): Promise<ResearchTreeDetail> {
  return trpc().research.createPost.mutate(request);
}

/** Adds a follow-up note under a post (`create_research_post_follow_up`). */
export function createResearchPostFollowUp(request: {
  parentNodeId: string;
  body: string;
}): Promise<ResearchNode> {
  return trpc().research.createPostFollowUp.mutate(request);
}

/** Replaces a note's text (`update_research_post`); refused with CONFLICT
 * when `expectedText` is no longer the stored text. */
export function updateResearchPost(request: {
  nodeId: string;
  text: string;
  expectedText: string;
}): Promise<UpdateResearchPostResult> {
  return trpc().research.updatePost.mutate(request);
}

/** Asks again for the X posts a note carries that could not be read. */
export function hydrateResearchPostTweet(nodeId: string): Promise<ResearchNode> {
  return trpc().research.hydratePostTweet.mutate({ nodeId });
}

/* -------------------------------------------------------------------------
 * images
 * ---------------------------------------------------------------------- */

/**
 * Uploads one image for a later question, draft or follow-up to name by id
 * (`POST /api/images`, multipart with one `file` field). Rejects with the
 * server's message: the type, size and rate limits are checked there.
 */
export async function uploadResearchImage(
  file: Blob,
  fileName?: string,
): Promise<ResearchImageAttachment> {
  const body = new FormData();
  body.append("file", file, fileName ?? (file instanceof File ? file.name : "image"));
  const response = await fetch(RESEARCH_IMAGE_UPLOAD_PATH, {
    method: "POST",
    body,
    credentials: "same-origin",
    headers: REQUESTED_WITH_HEADERS,
  });
  const payload = (await response.json().catch(() => null)) as
    ResearchImageAttachment | { error?: unknown } | null;
  if (!response.ok || payload === null || !("kind" in payload)) {
    const message =
      payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `The image could not be uploaded (${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

/* -------------------------------------------------------------------------
 * saved drafts
 * ---------------------------------------------------------------------- */

export function listResearchDrafts(workspaceId: string): Promise<ResearchDraft[]> {
  return trpc().drafts.list.query({ workspaceId });
}

/** Without an id, creates a draft at the top of the list; with one, replaces
 * its prompt. `images` (upload ids) replaces the draft's images; omitted, they
 * are kept. */
export function saveResearchDraft(request: {
  id?: string | null;
  workspaceId: string;
  prompt: string;
  images?: string[] | null;
}): Promise<ResearchDraft> {
  return trpc().drafts.save.mutate(request);
}

export function deleteResearchDraft(draftId: string) {
  return trpc().drafts.remove.mutate({ draftId });
}

/** `draftIds` must name exactly the workspace's drafts. */
export function reorderResearchDrafts(
  workspaceId: string,
  draftIds: string[],
): Promise<ResearchDraft[]> {
  return trpc().drafts.reorder.mutate({ workspaceId, draftIds });
}

/* -------------------------------------------------------------------------
 * Trash
 * ---------------------------------------------------------------------- */

/** Moves a thread, and the children listed under it, to the Trash. */
export function trashResearchTree(treeId: string): Promise<ResearchTree> {
  return trpc().research.trashTree.mutate({ treeId });
}

/** Takes a thread, and its children in the Trash, out of the Trash. */
export function restoreResearchTreeFromTrash(treeId: string): Promise<ResearchTree> {
  return trpc().research.restoreTreeFromTrash.mutate({ treeId });
}

/** The workspace's threads in the Trash, most recently trashed first. */
export function listResearchTrash(workspaceId: string): Promise<ResearchTreeSummary[]> {
  return trpc().research.listTrash.query({ workspaceId });
}

/** Deletes every thread and folder in the workspace's Trash. */
export function emptyResearchTrash(
  workspaceId: string,
): Promise<{ treeIds: string[]; folderIds: string[] }> {
  return trpc().research.emptyTrash.mutate({ workspaceId });
}

export function forkResearchNode(request: {
  parentNodeId: string;
  prompt: string;
  /** A registry model and an effort it accepts; absent, the parent's. */
  agent?: { model: string; effort?: string | null };
  /** The passage of the parent the follow-up was asked about. */
  anchor?: NodeAnchor | null;
  inline?: boolean;
  /** A failed or stopped question this one replaces. */
  replacesNodeId?: string;
  /** Image ids from `POST /api/images`. */
  images?: string[];
}): Promise<ResearchNode> {
  return trpc().research.forkNode.mutate(request);
}

/** Asks a follow-up at the end of the inline chain `headNodeId` belongs to:
 * sent at once when the chain can take it, queued on the server otherwise.
 * Replaces the desktop's client-side queue. */
export function askResearchFollowup(request: {
  headNodeId: string;
  prompt: string;
  model?: string;
  effort?: string | null;
  /** Image ids from `POST /api/images`. */
  images?: string[];
}): Promise<
  { kind: "sent"; node: ResearchNode } | { kind: "queued"; item: ResearchFollowupQueueItem }
> {
  return trpc().followups.ask.mutate(request);
}

/** Removes a queued follow-up; returns its chain's queue after it. */
export function cancelQueuedResearchFollowup(itemId: string): Promise<ResearchFollowupQueueItem[]> {
  return trpc().followups.cancel.mutate({ itemId });
}

/** Clears a refused follow-up's reason so the server sends it again. */
export function retryQueuedResearchFollowup(itemId: string): Promise<ResearchFollowupQueueItem[]> {
  return trpc().followups.retry.mutate({ itemId });
}

/** Reruns a settled question in place, replacing a complete answer. */
export function rerunResearchNode(nodeId: string): Promise<ResearchTreeDetail> {
  return trpc().research.rerunNode.mutate({ nodeId });
}

/** Stores a messages column's display order; `nodeIds` is exactly its chain. */
export function setResearchChainOrder(
  headNodeId: string,
  nodeIds: string[],
): Promise<ResearchNode> {
  return trpc().research.setChainOrder.mutate({ headNodeId, nodeIds });
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
 * feed
 * ---------------------------------------------------------------------- */

export function listRecentActivity(input?: {
  scope?: RecentActivityScope;
  workspaceId?: string;
  limit?: number;
  before?: RecentActivityCursor | null;
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

/** The root entries of the named threads, with their follow-ups, for Home
 * cards whose roots no feed page has loaded
 * (`list_recent_activity_for_trees`). */
export function listRecentActivityForTrees(treeIds: string[]): Promise<RecentResearchQuery[]> {
  return trpc().feed.recentQueriesForTrees.query({ treeIds });
}

/* -------------------------------------------------------------------------
 * events
 * ---------------------------------------------------------------------- */

export function setEventInterest(connectionId: string, nodeIds: string[]) {
  return trpc().events.setInterest.mutate({ connectionId, nodeIds });
}

/* -------------------------------------------------------------------------
 * artifacts: widget pages, revisions and saved inputs
 * ---------------------------------------------------------------------- */

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The pages of a widget block of a stored answer. The server resolves the
 * HTML from the answer by its SHA-256; it never serves HTML the client
 * sends. `runUrl` is null while widget scripts are off. */
export async function prepareResearchWidget(nodeId: string, html: string) {
  return trpc().artifacts.prepareWidget.mutate({ nodeId, sha256: await sha256Hex(html) });
}

/** The pages of a stored revision (the revision list's preview). */
export function prepareResearchWidgetRevision(reference: ResearchArtifactRef) {
  return trpc().artifacts.prepareWidget.mutate(reference);
}

/** Stores the revision of a displayed widget block
 * (`research_artifact_register`). */
export function registerResearchArtifact(input: {
  nodeId: string;
  slot: string;
  html: string;
  meta: string;
}): Promise<ResearchArtifactRevision> {
  return trpc().artifacts.register.mutate(input);
}

export function researchArtifactHistory(treeId: string, artifactId: string) {
  return trpc().artifacts.history.query({ treeId, artifactId });
}

/** `value` is null when nothing is saved (JSON transport drops `undefined`). */
function artifactState(state: { enabled: boolean; value?: unknown }): ResearchArtifactState {
  return { enabled: state.enabled, value: state.value ?? null };
}

export async function getResearchArtifactState(
  reference: ResearchArtifactRef,
): Promise<ResearchArtifactState> {
  return artifactState(await trpc().artifacts.getState.query(reference));
}

export async function updateResearchArtifactState(
  reference: ResearchArtifactRef,
  action: ArtifactStateAction,
  value: unknown = null,
): Promise<ResearchArtifactState> {
  return artifactState(await trpc().artifacts.updateState.mutate({ reference, action, value }));
}
