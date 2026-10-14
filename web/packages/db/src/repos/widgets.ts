// Widget artifacts (`widget_revisions`, `widget_state`): the immutable
// revisions of the `session-html` blocks answers produced, and each person's
// saved inputs for a revision. Ported from the desktop's research artifact
// store (`src-tauri/src/research_artifacts.rs`); the revision ids, the
// lineage order and the saved-input actions are the desktop's.
//
// The caller checks access to the tree and that the HTML is a block of the
// node's stored answer (`server/src/artifacts/revisions.ts`); these functions
// trust their input to name a readable tree.

import { createHash } from "node:crypto";

import type {
  ArtifactStateAction,
  ResearchArtifactRef,
  ResearchArtifactRevision,
  ResearchArtifactState,
} from "@session/shared";
import { MAX_SESSION_WIDGET_BYTES, sessionWidgetTitle } from "@session/shared";
import { widgetStateJson } from "@session/shared/lib/sessionArtifactState";
import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { widgetRevisions, widgetState } from "../schema/widgets.js";
import { now } from "../time.js";

/** Bytes of a revision's saved-input JSON. Mirrors `MAX_STATE_BYTES` in
 * `research_artifacts.rs`. */
export const MAX_WIDGET_STATE_BYTES = 16 * 1024;

/** The fallback title, as on the desktop. */
const DEFAULT_TITLE = "Answer widget";

const REVISION_UNAVAILABLE = "widget revision was not found";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRevisionHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

/** Same rule as `sessionWidgetMetadata` and the desktop's `is_artifact_id`. */
export function isArtifactId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
}

/** CRLF and LF content produce the same revision. */
function normalizeHtml(html: string): string {
  return html.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export interface ArtifactInput {
  treeId: string;
  nodeId: string;
  slot: string;
  artifactId?: string | undefined;
  title?: string | undefined;
  parentRevision?: string | undefined;
  html: string;
}

type RevisionRow = typeof widgetRevisions.$inferSelect;

/**
 * The wire revision. `parent_revision` holds the fence's declared `parent=`
 * as written (at most 128 characters), so a malformed value is kept; the
 * desktop stores the same fact as `invalidParent` with no parent. Either way
 * the wire shape has no parent and `unresolvedParent` set.
 */
function toRevision(row: RevisionRow, present: (revision: string) => boolean) {
  const declared = row.parentRevision;
  const parent = declared !== null && isRevisionHash(declared) ? declared : null;
  return {
    artifactId: row.artifactId,
    title: row.title,
    treeId: row.treeId,
    nodeId: row.nodeId,
    slot: row.slot,
    revision: row.revision,
    contentHash: row.contentHash,
    parentRevision: parent,
    html: row.html,
    createdAt: row.createdAt,
    unresolvedParent: declared !== null && (parent === null || !present(parent)),
  } satisfies ResearchArtifactRevision;
}

function revisionRow(db: SessionDatabase, reference: ResearchArtifactRef): RevisionRow | undefined {
  return db
    .select()
    .from(widgetRevisions)
    .where(
      and(
        eq(widgetRevisions.treeId, reference.treeId),
        eq(widgetRevisions.artifactId, reference.artifactId),
        eq(widgetRevisions.revision, reference.revision),
      ),
    )
    .get();
}

/** Whether `reference` names a stored revision. */
export function exists(db: SessionDatabase, reference: ResearchArtifactRef): boolean {
  return isRevisionHash(reference.revision) && revisionRow(db, reference) !== undefined;
}

/** One stored revision, or null. */
export function get(
  db: SessionDatabase,
  reference: ResearchArtifactRef,
): ResearchArtifactRevision | null {
  const row = revisionRow(db, reference);
  return row ? toRevision(row, (parent) => exists(db, { ...reference, revision: parent })) : null;
}

/**
 * Stores the revision of one widget block and returns it (the desktop's
 * `register`). A revision is immutable: registering the same source again
 * returns the stored record, whatever title or parent it now declares. A
 * fence without a valid id gets a legacy id derived from the answer and the
 * source, so identical unnamed widgets in one answer share a revision. A
 * declared parent that is not stored does not block the child, which is a
 * root until the parent is stored.
 */
export function register(db: SessionDatabase, input: ArtifactInput): ResearchArtifactRevision {
  const html = normalizeHtml(input.html);
  if (
    Buffer.byteLength(html, "utf8") > MAX_SESSION_WIDGET_BYTES ||
    input.treeId === "" ||
    input.nodeId === "" ||
    input.treeId.length > 256 ||
    input.nodeId.length > 256 ||
    input.slot.length > 256
  ) {
    throw new Error("invalid artifact source or owner");
  }
  const sourceHash = sha256(html);
  const artifactId =
    input.artifactId !== undefined && isArtifactId(input.artifactId)
      ? input.artifactId
      : `legacy-${sha256(`${input.nodeId}\0${sourceHash}`)}`;
  const declared = input.parentRevision?.slice(0, 128);
  const parent = declared !== undefined && isRevisionHash(declared) ? declared : null;
  const title = sessionWidgetTitle(input.title ?? "") || DEFAULT_TITLE;
  // `serde_json::to_string(&(artifact, node, source, parent))` on the desktop.
  const revision = sha256(JSON.stringify([artifactId, input.nodeId, sourceHash, parent]));
  if (parent === revision) {
    throw new Error("a revision cannot be its own parent");
  }
  const reference = { treeId: input.treeId, artifactId, revision };
  return transact(db, (tx) => {
    tx.insert(widgetRevisions)
      .values({
        treeId: input.treeId,
        artifactId,
        revision,
        nodeId: input.nodeId,
        slot: input.slot,
        title,
        contentHash: sourceHash,
        parentRevision: declared ?? null,
        html,
        createdAt: now(),
      })
      .onConflictDoNothing()
      .run();
    return get(tx, reference)!;
  });
}

/**
 * Every stored revision of an artifact in lineage order (the desktop's
 * `history`): roots (including revisions whose parent is unresolved) oldest
 * first, each followed by its descendants, siblings oldest first.
 */
export function history(
  db: SessionDatabase,
  treeId: string,
  artifactId: string,
): ResearchArtifactRevision[] {
  const rows = db
    .select()
    .from(widgetRevisions)
    .where(and(eq(widgetRevisions.treeId, treeId), eq(widgetRevisions.artifactId, artifactId)))
    .all();
  const present = new Set(rows.map((row) => row.revision));
  const revisions = rows
    .map((row) => toRevision(row, (parent) => present.has(parent)))
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt || compare(a.nodeId, b.nodeId) || compare(a.revision, b.revision),
    );
  const children = new Map<string, number[]>();
  const roots: number[] = [];
  revisions.forEach((revision, index) => {
    if (revision.parentRevision !== null && !revision.unresolvedParent) {
      const list = children.get(revision.parentRevision) ?? [];
      list.push(index);
      children.set(revision.parentRevision, list);
    } else {
      roots.push(index);
    }
  });
  const order: ResearchArtifactRevision[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const index = stack.pop()!;
    const revision = revisions[index]!;
    order.push(revision);
    stack.push(...[...(children.get(revision.revision) ?? [])].reverse());
  }
  return order;
}

/** Byte order, as Rust compares `String`s. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stateRow(db: SessionDatabase, userId: string, reference: ResearchArtifactRef) {
  return db
    .select({ stateJson: widgetState.stateJson })
    .from(widgetState)
    .where(
      and(
        eq(widgetState.treeId, reference.treeId),
        eq(widgetState.artifactId, reference.artifactId),
        eq(widgetState.revision, reference.revision),
        eq(widgetState.userId, userId),
      ),
    )
    .get();
}

function readState(
  db: SessionDatabase,
  userId: string,
  reference: ResearchArtifactRef,
): ResearchArtifactState {
  if (!exists(db, reference)) {
    throw new Error(REVISION_UNAVAILABLE);
  }
  const stored = stateRow(db, userId, reference)?.stateJson;
  return { enabled: stored?.enabled === true, value: stored?.value ?? null };
}

/** `userId`'s saved inputs for a revision; nothing saved reads as off. */
export function getState(
  db: SessionDatabase,
  userId: string,
  reference: ResearchArtifactRef,
): ResearchArtifactState {
  return readState(db, userId, reference);
}

/**
 * Applies one saved-input action for `userId` (the desktop's `update_state`):
 *
 * - `enable` turns remembering on; `disable` turns it off and forgets the value;
 * - `reset` forgets the value and keeps remembering on;
 * - `save` stores `value`, refused unless remembering is on;
 * - `migrate` copies the same person's saved value from the revision's
 *   parent, refused unless remembering is on and the parent has a value.
 *
 * The stored value is JSON of at most 16 KiB.
 */
export function updateState(
  db: SessionDatabase,
  userId: string,
  reference: ResearchArtifactRef,
  action: ArtifactStateAction,
  value: unknown,
): ResearchArtifactState {
  return transact(db, (tx) => {
    const state = readState(tx, userId, reference);
    switch (action) {
      case "enable":
        state.enabled = true;
        break;
      case "disable":
        state.enabled = false;
        state.value = null;
        break;
      case "reset":
        state.value = null;
        break;
      case "save":
        if (!state.enabled) {
          throw new Error("remembering inputs is disabled");
        }
        state.value = value ?? null;
        break;
      case "migrate": {
        if (!state.enabled) {
          throw new Error("enable remembering inputs before copying parent state");
        }
        const parent = get(tx, reference)?.parentRevision;
        if (!parent) {
          throw new Error("this revision has no parent");
        }
        const source = readState(tx, userId, { ...reference, revision: parent });
        if (!source.enabled || source.value === null) {
          throw new Error("the parent has no saved inputs");
        }
        state.value = source.value;
        break;
      }
    }
    const json = widgetStateJson(state.value);
    if (json === null || Buffer.byteLength(json, "utf8") > MAX_WIDGET_STATE_BYTES) {
      throw new Error("saved inputs exceed the 16 KiB limit");
    }
    const stored = {
      enabled: state.enabled,
      ...(state.value === null ? {} : { value: JSON.parse(json) as unknown }),
    };
    tx.insert(widgetState)
      .values({ ...reference, userId, stateJson: stored, updatedAt: now() })
      .onConflictDoUpdate({
        target: [
          widgetState.treeId,
          widgetState.artifactId,
          widgetState.revision,
          widgetState.userId,
        ],
        set: { stateJson: stored, updatedAt: now() },
      })
      .run();
    return { enabled: stored.enabled, value: stored.value ?? null };
  });
}
