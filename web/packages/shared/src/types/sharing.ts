// Web-only collaboration types: the people a thread is shared with, the
// invitations to it, presence, and server notifications
// (`03-api-and-events.md` §2 `sharing`, `invites`, `subscriptions`). The
// desktop has one person and none of these.

import { z } from "zod";

export const memberRoleSchema = z.enum(["commenter", "viewer"]);

/** The role an invitation or a membership grants. The owner is the thread's
 * creator and has no membership. */
export type MemberRole = z.infer<typeof memberRoleSchema>;

/** One person with access to a thread: the owner first, then the members in
 * the order they joined. */
export interface ThreadMember {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: "owner" | MemberRole;
  /** Who invited them; null for the owner or when that account is gone. */
  invitedBy: string | null;
  /** When they joined; the thread's creation for the owner. */
  joinedAt: number;
}

/** A pending invitation, as its thread's owner sees it. */
export interface ThreadInvite {
  id: string;
  treeId: string;
  role: MemberRole;
  /** Set for an invitation addressed to one GitHub account; null for a link
   * anyone holding it may accept. */
  githubLogin: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** An invitation addressed to the signed-in person's GitHub login. */
export interface ReceivedInvite {
  id: string;
  treeId: string;
  treeTitle: string;
  role: MemberRole;
  invitedBy: string | null;
  invitedByLogin: string | null;
  createdAt: number;
  expiresAt: number;
}

/** `invites.create`'s answer. `token` is shown once: only its hash is
 * stored. `url` is the link to share for a link invitation. */
export interface CreatedInvite {
  invite: ThreadInvite;
  token: string;
  url: string;
}

/** Who has a thread open (`research.presence.changed`). */
export interface ThreadViewer {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** The payload of a server `notification.requested` event. */
export interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  tone: "info" | "success" | "warning" | "error";
  timeoutMs: number;
  createdAt: number;
  /** The in-app path the notification opens, when there is one. */
  href?: string;
  /** What the notification is about, for a client that groups or filters. */
  kind?: "runFinished" | "followUp" | "branch" | "invite";
  treeId?: string;
}

/** What a notification is about. */
export type NotificationKind = NonNullable<NotificationPayload["kind"]>;

/** A stored notification in the recipient's inbox (`notifications.list`).
 * Every `notification.requested` is also stored as one of these, under the
 * same id. */
export interface InboxNotification {
  id: string;
  kind: NotificationKind;
  tone: NotificationPayload["tone"];
  treeId: string | null;
  title: string;
  body: string;
  href: string | null;
  createdAt: number;
  /** Null while unread. */
  readAt: number | null;
}

/** One page of the inbox, newest first. `nextCursor` reads the next page;
 * null on the last. */
export interface InboxNotificationPage {
  items: InboxNotification[];
  nextCursor: string | null;
}
