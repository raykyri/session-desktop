// Sharing a thread: visibility, members, invitations and Follow
// (`docs/02-domain-model-and-database.md` §5.16). Who may do what is
// `access.ts`; this module changes `tree_members`, `tree_invites`,
// `tree_subscriptions` and `trees.visibility`.

import { createHash, randomBytes } from "node:crypto";

import type {
  MemberRole,
  ReceivedInvite,
  ResearchTreeVisibility,
  ThreadInvite,
  ThreadMember,
} from "@session/shared";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { treeInvites, treeMembers, treeSubscriptions } from "../schema/collaboration.js";
import { followupQueue } from "../schema/followups.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { users } from "../schema/users.js";
import { now } from "../time.js";

import { memberRow, requireTreeAccess } from "./access.js";
import type { TreeRow } from "./mappers.js";
import { activeRun } from "./subtrees.js";
import { leave as leaveTree } from "./trees.js";

/** How long an invitation can be accepted. */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Most pending invitations one thread may have. */
export const MAX_PENDING_INVITES = 50;

/** Most members one thread may have. */
export const MAX_MEMBERS = 100;

export const INVITE_MESSAGES = {
  notFound: "This invitation was not found, has expired or was revoked.",
  otherAccount: "This invitation is for another GitHub account.",
  self: "You own this thread.",
  ownerRole: "The owner's role cannot be changed.",
  tooManyInvites: `A thread can have at most ${MAX_PENDING_INVITES} pending invitations.`,
  tooManyMembers: `A thread can be shared with at most ${MAX_MEMBERS} people.`,
} as const;

type InviteRow = typeof treeInvites.$inferSelect;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toInvite(row: InviteRow): ThreadInvite {
  return {
    id: row.id,
    treeId: row.treeId,
    role: row.role,
    githubLogin: row.githubLogin,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** A visibility change and the row before it, for the caller's feed events. */
export interface VisibilityChange {
  before: TreeRow;
  after: TreeRow;
  changed: boolean;
}

/** Makes the thread public or private. The owner's. */
export function setVisibility(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  visibility: ResearchTreeVisibility,
): VisibilityChange {
  return transact(db, (tx) => {
    const before = requireTreeAccess(tx, userId, treeId, "owner").tree;
    if (before.visibility === visibility) {
      return { before, after: before, changed: false };
    }
    const after = tx
      .update(trees)
      .set({ visibility, updatedAt: sql`max(${now()}, ${trees.updatedAt} + 1)` })
      .where(eq(trees.id, treeId))
      .returning()
      .get();
    return { before, after: after ?? before, changed: true };
  });
}

/** The owner and the members of a thread, for anyone who may read it. */
export function listMembers(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): ThreadMember[] {
  const tree = requireTreeAccess(db, userId, treeId, "viewer").tree;
  const owner = db
    .select({ id: users.id, login: users.login, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, tree.ownerId))
    .get();
  const members = db
    .select({
      member: treeMembers,
      login: users.login,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(treeMembers)
    .innerJoin(users, eq(users.id, treeMembers.userId))
    .where(eq(treeMembers.treeId, treeId))
    .orderBy(asc(treeMembers.createdAt), asc(treeMembers.userId))
    .all();
  return [
    ...(owner
      ? [
          {
            userId: owner.id,
            login: owner.login,
            name: owner.name,
            avatarUrl: owner.avatarUrl,
            role: "owner" as const,
            invitedBy: null,
            joinedAt: tree.createdAt,
          },
        ]
      : []),
    ...members.map((row) => ({
      userId: row.member.userId,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatarUrl,
      role: row.member.role,
      invitedBy: row.member.invitedBy,
      joinedAt: row.member.createdAt,
    })),
  ];
}

/** The user ids of a thread's members (not the owner). */
export function memberIds(db: SessionDatabase, treeId: string): string[] {
  return db
    .select({ userId: treeMembers.userId })
    .from(treeMembers)
    .where(eq(treeMembers.treeId, treeId))
    .orderBy(asc(treeMembers.userId))
    .all()
    .map((row) => row.userId);
}

/** The members of each of `ownerId`'s threads in a workspace, keyed by
 * thread, read before the workspace is removed. */
export function workspaceMembers(
  db: SessionDatabase,
  ownerId: string,
  workspaceId: string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of db
    .select({ treeId: treeMembers.treeId, userId: treeMembers.userId })
    .from(treeMembers)
    .innerJoin(trees, eq(trees.id, treeMembers.treeId))
    .where(and(eq(trees.ownerId, ownerId), eq(trees.workspaceId, workspaceId)))
    .all()) {
    const list = result.get(row.treeId) ?? [];
    list.push(row.userId);
    result.set(row.treeId, list);
  }
  return result;
}

/** Who may receive a thread's events: its owner, its members, and whether
 * anyone else may read it (a public thread outside its owner's Trash). */
export interface TreeAudience {
  treeId: string;
  ownerId: string;
  memberIds: string[];
  public: boolean;
}

export function audience(db: SessionDatabase, treeId: string): TreeAudience | null {
  const tree = db
    .select({ ownerId: trees.ownerId, visibility: trees.visibility, trashedAt: trees.trashedAt })
    .from(trees)
    .where(eq(trees.id, treeId))
    .get();
  if (!tree) {
    return null;
  }
  // A thread in its owner's Trash is the owner's alone.
  const hidden = tree.trashedAt !== null;
  return {
    treeId,
    ownerId: tree.ownerId,
    memberIds: hidden ? [] : memberIds(db, treeId),
    public: !hidden && tree.visibility === "public",
  };
}

/** Changes a member's role. The owner's. */
export function setRole(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  memberId: string,
  role: MemberRole,
): ThreadMember[] {
  transact(db, (tx) => {
    const tree = requireTreeAccess(tx, userId, treeId, "owner").tree;
    if (memberId === tree.ownerId) {
      throw new Error(INVITE_MESSAGES.ownerRole);
    }
    const row = tx
      .update(treeMembers)
      .set({ role })
      .where(and(eq(treeMembers.treeId, treeId), eq(treeMembers.userId, memberId)))
      .returning()
      .get();
    if (!row) {
      throw new Error(`member ${memberId} was not found`);
    }
  });
  return listMembers(db, userId, treeId);
}

/** What leaving or being removed took away from a member. */
export interface Departure {
  treeId: string;
  memberId: string;
  /** Their queued follow-ups, deleted with the membership. */
  removedFollowupIds: string[];
  /** The chains whose queues changed, for `research.queue.changed`. */
  changedHeadNodeIds: string[];
  /** Their questions still queued or running, which the caller cancels: a
   * person who can no longer read the thread cannot keep a run in it. */
  activeNodeIds: string[];
}

function depart(db: SessionDatabase, treeId: string, memberId: string): Departure {
  const queued = db
    .select({ id: followupQueue.id, headNodeId: followupQueue.headNodeId })
    .from(followupQueue)
    .where(and(eq(followupQueue.treeId, treeId), eq(followupQueue.authorId, memberId)))
    .all();
  if (queued.length > 0) {
    db.delete(followupQueue)
      .where(
        inArray(
          followupQueue.id,
          queued.map((row) => row.id),
        ),
      )
      .run();
  }
  const activeNodeIds = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.treeId, treeId), eq(nodes.authorId, memberId), activeRun()))
    .all()
    .map((row) => row.id);
  return {
    treeId,
    memberId,
    removedFollowupIds: queued.map((row) => row.id),
    changedHeadNodeIds: [...new Set(queued.map((row) => row.headNodeId))].sort(),
    activeNodeIds,
  };
}

/** Removes a member. The owner's. Their nodes and highlights stay. */
export function removeMember(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  memberId: string,
): Departure {
  return transact(db, (tx) => {
    requireTreeAccess(tx, userId, treeId, "owner");
    if (!memberRow(tx, memberId, treeId)) {
      throw new Error(`member ${memberId} was not found`);
    }
    const departure = depart(tx, treeId, memberId);
    tx.delete(treeMembers)
      .where(and(eq(treeMembers.treeId, treeId), eq(treeMembers.userId, memberId)))
      .run();
    tx.delete(treeSubscriptions)
      .where(and(eq(treeSubscriptions.treeId, treeId), eq(treeSubscriptions.userId, memberId)))
      .run();
    return departure;
  });
}

/** The caller leaves a thread shared with them. */
export function leave(db: SessionDatabase, userId: string, treeId: string): Departure {
  return transact(db, (tx) => {
    leaveTree(tx, userId, treeId);
    return depart(tx, treeId, userId);
  });
}

export interface CreateInviteInput {
  treeId: string;
  role: MemberRole;
  /** An invitation for one GitHub account; absent for a link. */
  githubLogin?: string | null | undefined;
}

/** A new invitation and the token that accepts it, which is not stored. */
export interface NewInvite {
  invite: ThreadInvite;
  token: string;
  /** The account a login invitation names, when it has signed in before. */
  inviteeId: string | null;
}

function pendingPredicate(at: number) {
  return and(isNull(treeInvites.revokedAt), gt(treeInvites.expiresAt, at));
}

/**
 * Invites someone to a thread, by GitHub login or by link. The owner's. A
 * login invitation is accepted once, by that account; a link invitation by
 * anyone who holds the link until it expires or is revoked.
 */
export function createInvite(
  db: SessionDatabase,
  userId: string,
  input: CreateInviteInput,
): NewInvite {
  const login = input.githubLogin?.trim().replace(/^@/u, "") ?? "";
  return transact(db, (tx) => {
    const tree = requireTreeAccess(tx, userId, input.treeId, "owner").tree;
    const at = now();
    const pending = tx
      .select({ value: sql<number>`count(*)` })
      .from(treeInvites)
      .where(
        and(eq(treeInvites.treeId, tree.id), pendingPredicate(at), isNull(treeInvites.acceptedAt)),
      )
      .get();
    if ((pending?.value ?? 0) >= MAX_PENDING_INVITES) {
      throw new Error(INVITE_MESSAGES.tooManyInvites);
    }
    const invitee =
      login === ""
        ? null
        : (tx
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.login}) = lower(${login})`)
            .get() ?? null);
    if (invitee?.id === tree.ownerId) {
      throw new Error(INVITE_MESSAGES.self);
    }
    const token = randomBytes(32).toString("base64url");
    const row = tx
      .insert(treeInvites)
      .values({
        id: newId(),
        treeId: tree.id,
        tokenHash: hashToken(token),
        role: input.role,
        githubLogin: login === "" ? null : login,
        createdBy: userId,
        createdAt: at,
        expiresAt: at + INVITE_TTL_MS,
        acceptedBy: null,
        acceptedAt: null,
        revokedAt: null,
      })
      .returning()
      .get();
    return { invite: toInvite(row), token, inviteeId: invitee?.id ?? null };
  });
}

/** A thread's pending invitations, newest first. The owner's. */
export function listInvites(db: SessionDatabase, userId: string, treeId: string): ThreadInvite[] {
  requireTreeAccess(db, userId, treeId, "owner");
  return db
    .select()
    .from(treeInvites)
    .where(
      and(eq(treeInvites.treeId, treeId), pendingPredicate(now()), isNull(treeInvites.acceptedAt)),
    )
    .orderBy(desc(treeInvites.createdAt), desc(treeInvites.id))
    .all()
    .map(toInvite);
}

/** The pending login invitations addressed to `login`, newest first. */
export function receivedInvites(db: SessionDatabase, login: string): ReceivedInvite[] {
  return db
    .select({ invite: treeInvites, treeTitle: trees.title, invitedByLogin: users.login })
    .from(treeInvites)
    .innerJoin(trees, eq(trees.id, treeInvites.treeId))
    .leftJoin(users, eq(users.id, treeInvites.createdBy))
    .where(
      and(
        sql`lower(${treeInvites.githubLogin}) = lower(${login})`,
        pendingPredicate(now()),
        isNull(treeInvites.acceptedAt),
        isNull(trees.trashedAt),
      ),
    )
    .orderBy(desc(treeInvites.createdAt), desc(treeInvites.id))
    .all()
    .map((row) => ({
      id: row.invite.id,
      treeId: row.invite.treeId,
      treeTitle: row.treeTitle,
      role: row.invite.role,
      invitedBy: row.invite.createdBy,
      invitedByLogin: row.invitedByLogin,
      createdAt: row.invite.createdAt,
      expiresAt: row.invite.expiresAt,
    }));
}

/** Revokes a pending invitation. The thread owner's. */
export function revokeInvite(db: SessionDatabase, userId: string, inviteId: string): ThreadInvite {
  return transact(db, (tx) => {
    const row = tx.select().from(treeInvites).where(eq(treeInvites.id, inviteId)).get();
    if (!row) {
      throw new Error(`invitation ${inviteId} was not found`);
    }
    requireTreeAccess(tx, userId, row.treeId, "owner");
    const updated = tx
      .update(treeInvites)
      .set({ revokedAt: row.revokedAt ?? now() })
      .where(eq(treeInvites.id, inviteId))
      .returning()
      .get();
    return toInvite(updated ?? row);
  });
}

/** What accepting an invitation did. */
export interface AcceptedInvite {
  treeId: string;
  role: MemberRole | "owner";
  /** False when the caller already had this role or a higher one. */
  joined: boolean;
}

/**
 * Accepts an invitation: by its token (a link, or a login invitation's link),
 * or by id for a login invitation addressed to the caller. Joining keeps a
 * higher role the caller already has. Expired, revoked and used login
 * invitations are "not found", as is an unknown token.
 */
export function acceptInvite(
  db: SessionDatabase,
  user: { id: string; login: string },
  by: { token: string } | { inviteId: string },
): AcceptedInvite {
  return transact(db, (tx) => {
    const at = now();
    const row = tx
      .select()
      .from(treeInvites)
      .where(
        and(
          "token" in by
            ? eq(treeInvites.tokenHash, hashToken(by.token))
            : eq(treeInvites.id, by.inviteId),
          pendingPredicate(at),
        ),
      )
      .get();
    const loginInvite = row?.githubLogin != null;
    if (!row || (loginInvite && row.acceptedAt !== null) || (!loginInvite && "inviteId" in by)) {
      throw new Error(INVITE_MESSAGES.notFound);
    }
    if (loginInvite && row.githubLogin?.toLowerCase() !== user.login.toLowerCase()) {
      throw new Error(INVITE_MESSAGES.otherAccount);
    }
    const tree = tx.select().from(trees).where(eq(trees.id, row.treeId)).get();
    if (!tree || tree.trashedAt !== null) {
      throw new Error(INVITE_MESSAGES.notFound);
    }
    if (tree.ownerId === user.id) {
      return { treeId: tree.id, role: "owner", joined: false };
    }
    const existing = memberRow(tx, user.id, tree.id);
    let joined = false;
    let role: MemberRole = row.role;
    if (!existing) {
      const count = tx
        .select({ value: sql<number>`count(*)` })
        .from(treeMembers)
        .where(eq(treeMembers.treeId, tree.id))
        .get();
      if ((count?.value ?? 0) >= MAX_MEMBERS) {
        throw new Error(INVITE_MESSAGES.tooManyMembers);
      }
      tx.insert(treeMembers)
        .values({
          treeId: tree.id,
          userId: user.id,
          role: row.role,
          invitedBy: row.createdBy,
          createdAt: at,
        })
        .run();
      joined = true;
    } else if (existing.role === "viewer" && row.role === "commenter") {
      tx.update(treeMembers)
        .set({ role: "commenter" })
        .where(and(eq(treeMembers.treeId, tree.id), eq(treeMembers.userId, user.id)))
        .run();
      joined = true;
    } else {
      role = existing.role;
    }
    if (row.acceptedAt === null) {
      tx.update(treeInvites)
        .set({ acceptedBy: user.id, acceptedAt: at })
        .where(eq(treeInvites.id, row.id))
        .run();
    }
    return { treeId: tree.id, role, joined };
  });
}

/** Follows or unfollows a thread (notifications for it). Anyone signed in
 * who may read it. Returns whether the caller follows it now. */
export function setFollowing(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  value: boolean,
): boolean {
  return transact(db, (tx) => {
    requireTreeAccess(tx, userId, treeId, "viewer");
    if (value) {
      tx.insert(treeSubscriptions)
        .values({ userId, treeId, createdAt: now() })
        .onConflictDoNothing()
        .run();
    } else {
      tx.delete(treeSubscriptions)
        .where(and(eq(treeSubscriptions.userId, userId), eq(treeSubscriptions.treeId, treeId)))
        .run();
    }
    return value;
  });
}

/** Everyone following a thread who may still read it. */
export function followers(db: SessionDatabase, treeId: string): string[] {
  const rows = db
    .select({ userId: treeSubscriptions.userId })
    .from(treeSubscriptions)
    .where(eq(treeSubscriptions.treeId, treeId))
    .orderBy(asc(treeSubscriptions.userId))
    .all();
  const tree = db.select().from(trees).where(eq(trees.id, treeId)).get();
  if (!tree) {
    return [];
  }
  return rows
    .map((row) => row.userId)
    .filter(
      (id) =>
        id === tree.ownerId ||
        (tree.trashedAt === null &&
          (tree.visibility === "public" || memberRow(db, id, treeId) !== null)),
    );
}
