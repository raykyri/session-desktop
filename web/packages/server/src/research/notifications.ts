// In-app notifications (`03-api-and-events.md` §3, `notification.requested`).
// There is no inbox: a notification is an event to the person's open
// connections, shown as a toast, and is lost when they have none open.
//
// Sent for:
// - a run you asked finishing (complete or failed), to its asker;
// - a new question or note in a thread you follow (`subscriptions.set`), to
//   every follower but its author;
// - a branch from your answer or note (a follow-up that is not inline), to
//   the parent's author, in place of the follow-up notification;
// - an invitation to a thread, to the invited account.

import { randomUUID } from "node:crypto";

import type { SessionDatabase } from "@session/db";
import { nodes, sharing, trees, users } from "@session/db";
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

/** Sends one notification to each of `userIds`. */
export function notify(
  deps: NotifyDeps,
  userIds: Iterable<string>,
  content: Omit<NotificationPayload, "id" | "createdAt" | "timeoutMs" | "tone"> &
    Partial<Pick<NotificationPayload, "tone" | "timeoutMs">>,
): void {
  const createdAt = Date.now();
  for (const userId of new Set(userIds)) {
    const payload: NotificationPayload = {
      id: randomUUID(),
      tone: "info",
      timeoutMs: TIMEOUT_MS,
      createdAt,
      ...content,
    };
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

/** A question or note was added to a thread by `actorId`. */
export function notifyNewNode(deps: NotifyDeps, actorId: string, node: ResearchNode): void {
  const title = treeTitle(deps.db, node.treeId);
  const actor = users.findById(deps.db, actorId);
  const who = actor?.login ?? "Someone";
  const kindLabel = node.type === "post" ? "note" : "question";
  const notified = new Set<string>([actorId]);
  if (node.parentNodeId != null && node.inline !== true) {
    const parentAuthor = parentAuthorOf(deps, node);
    if (parentAuthor !== null && !notified.has(parentAuthor)) {
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

/** A run settled: its asker hears whether it completed or failed. A
 * cancelled run was stopped by someone and says nothing. */
export function notifyRunFinished(deps: NotifyDeps, node: ResearchNode): void {
  const status = nodeStatus(node);
  const asker = authorOf(node);
  if (asker === null || (status !== "complete" && status !== "failed")) {
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
    // No link: the thread opens once the invitation is accepted
    // (`invites.received`, `invites.accept`).
    body: treeTitle(deps.db, treeId),
  });
}
