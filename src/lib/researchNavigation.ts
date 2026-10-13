// Research navigation restoration state (selected node and per-node scroll
// offsets, keyed by tree). Stored as a module-level singleton so the workspace
// (which reads/writes selections) and the app shell (which prunes entries for
// deleted trees) mutate the same object. A separate in-memory copy could restore
// pruned localStorage data on the next save.

import type { ResearchScrollKind } from "./researchColumns";
import type { ResearchHighlightAnchor, ResearchImageAttachment } from "../types";

interface SavedResearchScrollPosition {
  top: number;
  updatedAt: number;
}

/** A pending branch (UI: New branch): the passage of the parent's answer it
 * is asked about and whatever the user has typed so far. Persisted so
 * leaving the research surface — which unmounts the thread page — does not
 * discard it; removed only by submit or an explicit dismiss. */
interface SavedPendingBranch {
  anchor: ResearchHighlightAnchor;
  text: string;
  updatedAt: number;
}

/** The root follow-up composer's draft. Unlike a pending branch, this belongs
 * to the tree rather than a passage. */
interface SavedResearchFollowupDraft {
  text: string;
  updatedAt: number;
}

/** A follow-up submitted while its chain's tail was still running. It is
 * sent from the client when that tail completes. */
export interface QueuedResearchFollowup {
  id: string;
  prompt: string;
  createdAt: number;
  /** Images sent with the question. Absent when it has none. */
  images?: ResearchImageAttachment[];
  /** Why sending it failed. A failed question is not sent again until the
   * reader retries it; this is not restored on load, so a reload retries. */
  failed?: string;
}

export interface SavedResearchNavigation {
  /** The deepest open level's selected message. Without `selectionPath`,
   * the levels before it are the ones it was asked from, each with the
   * message its branch was asked from selected. */
  selectedNodeId?: string;
  /** Each column's selected message, root column first, when it ends with
   * `selectedNodeId`. A column's selection need not be the message the next
   * column's branch was asked from. */
  selectionPath?: string[];
  scrollByNode: Record<string, SavedResearchScrollPosition>;
  /** Nodes whose "Show earlier" window the user expanded. Restore this with
   * the scroll offset because expanded and collapsed lists use different offsets. */
  expandedByNode?: Record<string, boolean>;
  /** Pending branches, keyed by the parent node they were started on. The
   * stored field keeps the earlier name, "ask". */
  askByNode?: Record<string, SavedPendingBranch>;
  /** In-progress text in the root follow-up composer. */
  followupDraft?: SavedResearchFollowupDraft;
  /** A highlight to scroll into view on the next page visit (set when a
   * Highlights feed unit is opened). Cleared after the thread page selects it. */
  focusHighlight?: { nodeId: string; highlightId: string };
  /** Queued follow-ups per chain, keyed by the chain's head node. */
  queuedFollowups?: Record<string, QueuedResearchFollowup[]>;
  /** Each level's messages column scroll offset, keyed by the head node of
   * the conversation or branch it shows. (`scrollByNode` stores the answer
   * columns', keyed by the message.) The stored field keeps the column's
   * earlier name, "turns". */
  turnsScrollByHead?: Record<string, SavedResearchScrollPosition>;
  /** Each branches column's scroll offset, keyed by the head node of its
   * first branch. */
  branchesScrollBySource?: Record<string, SavedResearchScrollPosition>;
  /** The images in the thread's ask boxes, keyed as the page keys their
   * text, so they survive a restart with the text. They are pending images,
   * which the backend removes after a day, so they are not restored after
   * that. */
  composerImages?: {
    images: Record<string, ResearchImageAttachment[]>;
    updatedAt: number;
  };
}

/** The stored offsets of one kind of column. */
function scrollPositionsOf(
  navigation: SavedResearchNavigation | undefined,
  column: ResearchScrollKind,
): Record<string, SavedResearchScrollPosition> | undefined {
  switch (column) {
    case "answer":
      return navigation?.scrollByNode;
    case "messages":
      return navigation?.turnsScrollByHead;
    case "branches":
      return navigation?.branchesScrollBySource;
  }
}

const RESEARCH_NAVIGATION_KEY = "session.research-navigation.v1";
export const RESEARCH_SCROLL_POSITION_TTL_MS = 15 * 60 * 1000;
/** How long the backend keeps a pending image (PENDING_LIFETIME in
 * src-tauri/src/research_images.rs). */
export const RESEARCH_COMPOSER_IMAGES_TTL_MS = 24 * 60 * 60 * 1000;

let store: Record<string, SavedResearchNavigation> | null = null;

export function isResearchNodeSelectionChange(
  selectedNodeId: string | null,
  nextNodeId: string,
): boolean {
  return selectedNodeId !== nextNodeId;
}

/** The node a thread's feed card opens at: the tree's root question. Null
 * when `trees` does not list the tree; the thread then opens at the
 * selection it restores. */
export function researchFeedCardNodeId(
  trees: readonly { id: string; rootNodeId: string }[],
  treeId: string,
): string | null {
  return trees.find((tree) => tree.id === treeId)?.rootNodeId ?? null;
}

function isSavedAnchor(value: unknown): value is ResearchHighlightAnchor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const anchor = value as Partial<ResearchHighlightAnchor>;
  return (
    anchor.version === 1 &&
    anchor.projection === "answer-v1" &&
    typeof anchor.responseRevision === "string" &&
    typeof anchor.start === "number" &&
    typeof anchor.end === "number" &&
    typeof anchor.exact === "string" &&
    typeof anchor.prefix === "string" &&
    typeof anchor.suffix === "string"
  );
}

function load(): Record<string, SavedResearchNavigation> {
  try {
    const now = Date.now();
    const parsed = JSON.parse(localStorage.getItem(RESEARCH_NAVIGATION_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([treeId, value]) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const candidate = value as Partial<SavedResearchNavigation>;
        const scrollPositions = (record: Record<string, unknown> | undefined) => Object.fromEntries(
          Object.entries(record ?? {}).flatMap(([nodeId, value]) => {
            if (!value || typeof value !== "object") {
              // The previous schema stored a bare number, which has no age and
              // therefore cannot safely be carried into the expiring cache.
              return [];
            }
            const position = value as Partial<SavedResearchScrollPosition>;
            return typeof position.top === "number" &&
              Number.isFinite(position.top) &&
              position.top >= 0 &&
              typeof position.updatedAt === "number" &&
              Number.isFinite(position.updatedAt) &&
              now - position.updatedAt < RESEARCH_SCROLL_POSITION_TTL_MS
              ? [[nodeId, { top: position.top, updatedAt: position.updatedAt }]]
              : [];
          }),
        );
        const scrollByNode = scrollPositions(candidate.scrollByNode);
        const turnsScrollByHead = scrollPositions(candidate.turnsScrollByHead);
        const branchesScrollBySource = scrollPositions(candidate.branchesScrollBySource);
        const expandedByNode = Object.fromEntries(
          Object.entries(candidate.expandedByNode ?? {}).filter(
            (entry): entry is [string, boolean] => entry[1] === true,
          ),
        );
        const askByNode = Object.fromEntries(
          Object.entries(candidate.askByNode ?? {}).flatMap(([nodeId, value]) => {
            if (!value || typeof value !== "object") {
              return [];
            }
            const branch = value as Partial<SavedPendingBranch>;
            return isSavedAnchor(branch.anchor) &&
              typeof branch.text === "string" &&
              typeof branch.updatedAt === "number" &&
              Number.isFinite(branch.updatedAt)
              ? [[nodeId, { anchor: branch.anchor, text: branch.text, updatedAt: branch.updatedAt }]]
              : [];
          }),
        );
        // Drafts saved before the composer lost its thread/branch mode still
        // carry a `mode`; only the text is kept.
        const followupDraft =
          candidate.followupDraft &&
          typeof candidate.followupDraft === "object" &&
          typeof candidate.followupDraft.text === "string" &&
          candidate.followupDraft.text.length > 0 &&
          typeof candidate.followupDraft.updatedAt === "number" &&
          Number.isFinite(candidate.followupDraft.updatedAt)
            ? {
                text: candidate.followupDraft.text,
                updatedAt: candidate.followupDraft.updatedAt,
              }
            : undefined;
        const focusHighlight =
          candidate.focusHighlight &&
          typeof candidate.focusHighlight === "object" &&
          typeof candidate.focusHighlight.nodeId === "string" &&
          typeof candidate.focusHighlight.highlightId === "string"
            ? {
                nodeId: candidate.focusHighlight.nodeId,
                highlightId: candidate.focusHighlight.highlightId,
              }
            : undefined;
        const queuedFollowups = Object.fromEntries(
          Object.entries(candidate.queuedFollowups ?? {}).flatMap(([headId, value]) => {
            if (!Array.isArray(value)) {
              return [];
            }
            const queue = value.flatMap((entry: unknown) => {
              const item = entry as Partial<QueuedResearchFollowup> | null;
              if (
                !item ||
                typeof item.id !== "string" ||
                typeof item.prompt !== "string" ||
                !item.prompt.trim() ||
                typeof item.createdAt !== "number" ||
                !Number.isFinite(item.createdAt)
              ) {
                return [];
              }
              const images = storedImages(item.images);
              return [
                {
                  id: item.id,
                  prompt: item.prompt,
                  createdAt: item.createdAt,
                  ...(images.length > 0 ? { images } : {}),
                },
              ];
            });
            return queue.length > 0 ? [[headId, queue]] : [];
          }),
        );
        const savedComposerImages = candidate.composerImages;
        const composerImageEntries =
          savedComposerImages &&
          typeof savedComposerImages === "object" &&
          typeof savedComposerImages.updatedAt === "number" &&
          Number.isFinite(savedComposerImages.updatedAt) &&
          now - savedComposerImages.updatedAt < RESEARCH_COMPOSER_IMAGES_TTL_MS &&
          savedComposerImages.images &&
          typeof savedComposerImages.images === "object"
            ? Object.entries(savedComposerImages.images).flatMap(([key, value]) => {
                const images = storedImages(value);
                return images.length > 0 ? [[key, images] as const] : [];
              })
            : [];
        const composerImages =
          composerImageEntries.length > 0 && savedComposerImages
            ? { images: Object.fromEntries(composerImageEntries), updatedAt: savedComposerImages.updatedAt }
            : undefined;
        const selectionPath =
          Array.isArray(candidate.selectionPath) &&
          candidate.selectionPath.length > 0 &&
          candidate.selectionPath.every((id: unknown) => typeof id === "string")
            ? [...candidate.selectionPath]
            : undefined;
        return [[treeId, {
          selectedNodeId:
            typeof candidate.selectedNodeId === "string" ? candidate.selectedNodeId : undefined,
          ...(selectionPath ? { selectionPath } : {}),
          scrollByNode,
          ...(Object.keys(expandedByNode).length > 0 ? { expandedByNode } : {}),
          ...(Object.keys(askByNode).length > 0 ? { askByNode } : {}),
          ...(followupDraft ? { followupDraft } : {}),
          ...(focusHighlight ? { focusHighlight } : {}),
          ...(Object.keys(queuedFollowups).length > 0 ? { queuedFollowups } : {}),
          ...(Object.keys(turnsScrollByHead).length > 0 ? { turnsScrollByHead } : {}),
          ...(Object.keys(branchesScrollBySource).length > 0 ? { branchesScrollBySource } : {}),
          ...(composerImages ? { composerImages } : {}),
        } satisfies SavedResearchNavigation]];
      }),
    );
  } catch {
    return {};
  }
}

/** The well-formed image attachments of a stored queued question or ask
 * box. The backend checks each image again when the question is sent. */
function storedImages(value: unknown): ResearchImageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const image = entry as Partial<ResearchImageAttachment> | null;
    return image &&
      image.kind === "image" &&
      typeof image.id === "string" &&
      typeof image.mimeType === "string" &&
      typeof image.byteSize === "number"
      ? [
          {
            kind: "image" as const,
            id: image.id,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            ...(typeof image.width === "number" ? { width: image.width } : {}),
            ...(typeof image.height === "number" ? { height: image.height } : {}),
            ...(typeof image.fileName === "string" ? { fileName: image.fileName } : {}),
          },
        ]
      : [];
  });
}

export function researchNavigationStore(): Record<string, SavedResearchNavigation> {
  return (store ??= load());
}

export function saveResearchNavigation(): void {
  try {
    localStorage.setItem(RESEARCH_NAVIGATION_KEY, JSON.stringify(researchNavigationStore()));
  } catch {
    // Navigation restoration is a convenience; storage denial must not break research.
  }
}


export function recordResearchScrollPosition(
  navigation: SavedResearchNavigation,
  nodeId: string,
  top: number,
  now = Date.now(),
  column: ResearchScrollKind = "answer",
): void {
  const positions =
    column === "answer"
      ? navigation.scrollByNode
      : column === "messages"
        ? (navigation.turnsScrollByHead ??= {})
        : (navigation.branchesScrollBySource ??= {});
  positions[nodeId] = { top, updatedAt: now };
}

export function restoreResearchScrollPosition(
  navigation: SavedResearchNavigation | undefined,
  nodeId: string,
  now = Date.now(),
  column: ResearchScrollKind = "answer",
): number {
  const position = scrollPositionsOf(navigation, column)?.[nodeId];
  if (!position || now - position.updatedAt >= RESEARCH_SCROLL_POSITION_TTL_MS) {
    return 0;
  }
  return position.top;
}

/** Updates the root follow-up composer's draft and reports whether the stored
 * value changed. Empty text removes the saved draft so it cannot be restored
 * after sending or clearing the composer. */
export function recordResearchFollowupDraft(
  navigation: SavedResearchNavigation,
  text: string,
  now = Date.now(),
): boolean {
  if (text.length === 0) {
    if (!navigation.followupDraft) {
      return false;
    }
    delete navigation.followupDraft;
    return true;
  }
  const existing = navigation.followupDraft;
  if (existing && existing.text === text) {
    return false;
  }
  navigation.followupDraft = { text, updatedAt: now };
  return true;
}

/** The images a tree's ask boxes held, unless they were saved more than
 * a day ago. */
export function savedResearchComposerImages(
  treeId: string,
  now = Date.now(),
): Record<string, ResearchImageAttachment[]> {
  const saved = researchNavigationStore()[treeId]?.composerImages;
  return saved && now - saved.updatedAt < RESEARCH_COMPOSER_IMAGES_TTL_MS ? saved.images : {};
}

/** Stores the images in a tree's ask boxes; none removes them. */
export function recordResearchComposerImages(
  treeId: string,
  images: Record<string, ResearchImageAttachment[]>,
  now = Date.now(),
): void {
  const store = researchNavigationStore();
  const navigation = store[treeId];
  const empty = Object.keys(images).length === 0;
  if (empty && !navigation?.composerImages) return;
  if (navigation?.composerImages && JSON.stringify(navigation.composerImages.images) === JSON.stringify(images)) {
    return;
  }
  if (empty) {
    delete navigation!.composerImages;
  } else {
    (store[treeId] ??= { scrollByNode: {} }).composerImages = { images, updatedAt: now };
  }
  saveResearchNavigation();
}

/** Drops navigation state for trees that no longer exist. */
export function pruneResearchNavigation(validTreeIds: Iterable<string>): void {
  const valid = new Set(validTreeIds);
  const current = researchNavigationStore();
  let changed = false;
  for (const treeId of Object.keys(current)) {
    if (!valid.has(treeId)) {
      delete current[treeId];
      changed = true;
    }
  }
  if (changed) {
    saveResearchNavigation();
  }
}

/** The selection a tree's saved navigation restores: `selectionPath` when
 * it ends with `selectedNodeId`, else `selectedNodeId` alone (the levels it
 * was asked from open with it), else null. */
export function savedResearchSelection(navigation: SavedResearchNavigation | undefined): string | string[] | null {
  const nodeId = navigation?.selectedNodeId;
  if (!nodeId) {
    return null;
  }
  const path = navigation.selectionPath;
  return path && path[path.length - 1] === nodeId ? [...path] : nodeId;
}

/** Drops per-node state (scroll offsets, selection) for deleted nodes of a tree. */
export function pruneResearchNavigationNodes(treeId: string, validNodeIds: Iterable<string>): void {
  const navigation = researchNavigationStore()[treeId];
  if (!navigation) {
    return;
  }
  const valid = new Set(validNodeIds);
  let changed = false;
  for (const nodeId of Object.keys(navigation.scrollByNode)) {
    if (!valid.has(nodeId)) {
      delete navigation.scrollByNode[nodeId];
      changed = true;
    }
  }
  for (const nodeId of Object.keys(navigation.expandedByNode ?? {})) {
    if (!valid.has(nodeId)) {
      delete navigation.expandedByNode?.[nodeId];
      changed = true;
    }
  }
  for (const nodeId of Object.keys(navigation.askByNode ?? {})) {
    if (!valid.has(nodeId)) {
      delete navigation.askByNode?.[nodeId];
      changed = true;
    }
  }
  for (const headId of Object.keys(navigation.turnsScrollByHead ?? {})) {
    if (!valid.has(headId)) {
      delete navigation.turnsScrollByHead?.[headId];
      changed = true;
    }
  }
  for (const headId of Object.keys(navigation.branchesScrollBySource ?? {})) {
    if (!valid.has(headId)) {
      delete navigation.branchesScrollBySource?.[headId];
      changed = true;
    }
  }
  for (const headId of Object.keys(navigation.queuedFollowups ?? {})) {
    if (!valid.has(headId)) {
      delete navigation.queuedFollowups?.[headId];
      changed = true;
    }
  }
  if (navigation.selectedNodeId && !valid.has(navigation.selectedNodeId)) {
    delete navigation.selectedNodeId;
    changed = true;
  }
  if (navigation.selectionPath?.some((nodeId) => !valid.has(nodeId))) {
    delete navigation.selectionPath;
    changed = true;
  }
  if (changed) {
    saveResearchNavigation();
  }
}
