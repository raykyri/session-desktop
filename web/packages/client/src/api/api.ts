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
  NodeAnchor,
  RecentActivityCursor,
  RecentActivityPage,
  RecentActivityScope,
  RecentResearchQueryCursor,
  ResearchBranchRemoval,
  ResearchFolderState,
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
  User,
  UserSettings,
  Workspace,
} from "@session/shared";

import { trpc } from "./trpc.js";

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
  workspaceId: string;
}): Promise<ResearchTreeDetail> {
  return trpc().research.createTree.mutate(request);
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

/* -------------------------------------------------------------------------
 * events
 * ---------------------------------------------------------------------- */

export function setEventInterest(connectionId: string, nodeIds: string[]) {
  return trpc().events.setInterest.mutate({ connectionId, nodeIds });
}

/** Mints a preview of a widget block of a stored answer. The server resolves
 * the HTML from the answer by its SHA-256; it never serves HTML the client
 * sends. */
export async function prepareWidgetPreview(nodeId: string, html: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return trpc().artifacts.prepareWidget.mutate({ nodeId, sha256 });
}
