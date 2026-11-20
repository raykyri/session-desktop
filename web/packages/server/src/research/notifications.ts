// In-app notifications (`03-api-and-events.md` §3, `notification.requested`).
// Each one is stored in the recipient's inbox (`notifications` table,
// `notifications.list`) and sent to their open connections, which show it as
// a toast when the Notifications setting is on.
//
// Sent for:
// - a submitted run finishing (complete or failed), to its author;
// - a new question or note in a thread you follow (`subscriptions.set`), to
//   every follower but its author;
// - a branch from your answer or note (a follow-up that is not inline), to
//   the parent's author, in place of the follow-up notification;
// - an invitation to a thread, to the invited account.
//
// Notifications are not sent for threads the user can no longer access.

import { randomUUID } from "node:crypto";

import type { SessionDatabase } from "@session/db";
import { access, nodes, notifications, sharing, trees, users } from "@session/db";
import type { NotificationPayload, ResearchNode } from "@session/shared";
import { nodePrompt, nodeStatus } from "@session/shared/lib/researchNodeTypes";

import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";

export interface NotifyDeps {
  db: SessionDatabase;
  eventBus: EventBus;
}

const TIMEOUT_MS = 8_000;

/** The opening of a node's text, for a notification body. */
function excerpt(text: string, limit = 140): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function threadHref(treeId: string, nodeId?: string): string {
  return nodeId === undefined
    ? `/r/${encodeURIComponent(treeId)}`
    : `/r/${encodeURIComponent(treeId)}?sel=${encodeURIComponent(nodeId)}`;
}

/** Sends one notification to each of `userIds`: stored in their inbox
 * (`repos/notifications.ts`), then sent to their open connections, where the
 * client shows it as a toast unless they turned notifications off. */
export function notify(
  deps: NotifyDeps,
  userIds: Iterable<string>,
  content: Omit<NotificationPayload, "id" | "createdAt" | "timeoutMs" | "tone" | "kind"> &
    Required<Pick<NotificationPayload, "kind">> &
    Partial<Pick<NotificationPayload, "tone" | "timeoutMs">>,
): void {
  const createdAt = Date.now();
  const payloads = [...new Set(userIds)].map(
    (userId): { userId: string; payload: NotificationPayload } => ({
      userId,
      payload: {
        id: randomUUID(),
        tone: "info",
        timeoutMs: TIMEOUT_MS,
        createdAt,
        ...content,
      },
    }),
  );
  notifications.record(
    deps.db,
    payloads.map(({ userId, payload }) => ({
      id: payload.id,
      userId,
      kind: content.kind,
      tone: payload.tone,
      treeId: payload.treeId ?? null,
      title: payload.title,
      body: payload.body,
      href: payload.href ?? null,
      createdAt,
    })),
  );
  for (const { userId, payload } of payloads) {
    deps.eventBus.emit(userId, sessionEvent("notification.requested", { ...payload }));
  }
}

/** A thread's title, read through its owner, who can always read it. */
function treeTitle(db: SessionDatabase, treeId: string): string {
  const audience = sharing.audience(db, treeId);
  return audience ? (trees.get(db, audience.ownerId, treeId)?.title ?? "") : "";
}

function authorOf(node: ResearchNode): string | null {
  return node.authorId ?? null;
}

/** Whether `userId` may still read the thread: a person removed from it, or
 * a former reader of a thread that turned private, receives no notifications
 * about it. */
function canRead(db: SessionDatabase, userId: string, treeId: string): boolean {
  return access.treeAccess(db, userId, treeId) !== null;
}

/** A question or note was added to a thread by `actorId`. */
export function notifyNewNode(deps: NotifyDeps, actorId: string, node: ResearchNode): void {
  const title = treeTitle(deps.db, node.treeId);
  const actor = users.findById(deps.db, actorId);
  const who = actor?.login ?? "Someone";
  const kindLabel = node.type === "post" ? "note" : "question";
  const notified = new Set<string>([actorId]);
  if (node.parentNodeId != null && node.inline !== true) {
    const parentAuthor = parentAuthorOf(deps, node);
    if (
      parentAuthor !== null &&
      !notified.has(parentAuthor) &&
      canRead(deps.db, parentAuthor, node.treeId)
    ) {
      notified.add(parentAuthor);
      notify(deps, [parentAuthor], {
        kind: "branch",
        treeId: node.treeId,
        title: `${who} branched from your ${parentAuthorKind(deps, node)}`,
        body: excerpt(nodePrompt(node)),
        href: threadHref(node.treeId, node.id),
      });
    }
  }
  const followers = sharing.followers(deps.db, node.treeId).filter((id) => !notified.has(id));
  if (followers.length > 0) {
    notify(deps, followers, {
      kind: "followUp",
      treeId: node.treeId,
      title: `New ${kindLabel} in ${title === "" ? "a thread you follow" : title}`,
      body: `${who}: ${excerpt(nodePrompt(node))}`,
      href: threadHref(node.treeId, node.id),
    });
  }
}

function parentRow(deps: NotifyDeps, node: ResearchNode): ResearchNode | null {
  if (node.parentNodeId == null) return null;
  const audience = sharing.audience(deps.db, node.treeId);
  if (!audience) return null;
  return nodes.get(deps.db, audience.ownerId, node.parentNodeId);
}

function parentAuthorOf(deps: NotifyDeps, node: ResearchNode): string | null {
  const parent = parentRow(deps, node);
  return parent ? authorOf(parent) : null;
}

function parentAuthorKind(deps: NotifyDeps, node: ResearchNode): string {
  const parent = parentRow(deps, node);
  return parent?.type === "post" ? "note" : parent?.type === "document" ? "document" : "answer";
}

/** A run settled: its author receives a notification of whether it
 * completed or failed. A cancelled run emits no notification. */
export function notifyRunFinished(deps: NotifyDeps, node: ResearchNode): void {
  const status = nodeStatus(node);
  const asker = authorOf(node);
  if (
    asker === null ||
    (status !== "complete" && status !== "failed") ||
    !canRead(deps.db, asker, node.treeId)
  ) {
    return;
  }
  notify(deps, [asker], {
    kind: "runFinished",
    treeId: node.treeId,
    tone: status === "complete" ? "success" : "error",
    title: status === "complete" ? "Research finished" : "Research failed",
    body: excerpt(node.title ?? nodePrompt(node)),
    href: threadHref(node.treeId, node.id),
  });
}

/** An invitation to a thread, to the account it names. */
export function notifyInvite(
  deps: NotifyDeps,
  inviteeId: string,
  treeId: string,
  inviterLogin: string,
): void {
  notify(deps, [inviteeId], {
    kind: "invite",
    treeId,
    title: `${inviterLogin} shared a thread with you`,
    // The thread opens once the invitation is accepted, from Shared with me
    // (`invites.received`, `invites.accept`).
    body: treeTitle(deps.db, treeId),
    href: "/shared",
  });
}
