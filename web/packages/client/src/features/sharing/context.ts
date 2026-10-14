// The thread page's collaboration state for the components under it (web
// only): what the reader may do (`permissions.ts`) and who wrote what
// (`ResearchTreeDetail.participants`). A context rather than props: the
// author chips and the gates sit several components below the page.

import type { ResearchNode, ResearchParticipant, ResearchTreeDetail } from "@session/shared";
import { stalledTailNote } from "@session/shared";
import { createContext, useContext } from "react";

import { threadPermissions, type ThreadPermissions } from "./permissions.js";

export interface ThreadPeople {
  /** Participants by id. */
  byId: ReadonlyMap<string, ResearchParticipant>;
  /** More than one person is in the thread: author chips show. */
  shared: boolean;
  /** The signed-in reader, shown as "You". */
  meId: string | null;
}

export interface ThreadCollaboration {
  permissions: ThreadPermissions;
  people: ThreadPeople;
}

const NO_PEOPLE: ThreadPeople = { byId: new Map(), shared: false, meId: null };

/** Outside a thread page (and in the desktop-shaped tests): the owner of a
 * thread nobody else is in. */
export const SOLO_COLLABORATION: ThreadCollaboration = {
  permissions: threadPermissions(undefined, "me"),
  people: NO_PEOPLE,
};

export const ThreadCollaborationContext = createContext<ThreadCollaboration>(SOLO_COLLABORATION);

export function useThreadCollaboration(): ThreadCollaboration {
  return useContext(ThreadCollaborationContext);
}

/** The people of a thread detail. */
export function threadPeople(
  detail: Pick<ResearchTreeDetail, "participants"> | undefined,
  meId: string | null,
): ThreadPeople {
  const participants = detail?.participants ?? [];
  return {
    byId: new Map(participants.map((participant) => [participant.id, participant])),
    shared: participants.length > 1,
    meId,
  };
}

/** A participant's display name: their name, else their login. */
export function participantName(participant: Pick<ResearchParticipant, "name" | "login">): string {
  return participant.name?.trim() || participant.login;
}

/**
 * The note above a chain's ask box when its last answer stopped, for the
 * reader (the shared `stalledTailNote`, which the server's `followups.ask`
 * refusal uses too). The person who pays for that answer gets the desktop's
 * sentences; anyone else is told who can retry it and what they can do.
 */
export function stalledChainNote(
  tail: Pick<ResearchNode, "authorId"> & { status: "failed" | "stopped" },
  permissions: Pick<ThreadPermissions, "userId" | "ownerId" | "isOwner">,
  people: Pick<ThreadPeople, "byId">,
): string {
  const payer = tail.authorId == null ? permissions.ownerId : tail.authorId;
  const person = payer === null ? undefined : people.byId.get(payer);
  return stalledTailNote({
    status: tail.status,
    readerIsPayer: payer === permissions.userId,
    readerIsOwner: permissions.isOwner,
    payerIsOwner: payer !== null && payer === permissions.ownerId,
    payerName: person ? participantName(person) : "the person who asked it",
  });
}

/** Who last replaced a note's or document's text, when that was not its
 * author: the "Edited" mark then names them. */
export function editedByOther(node: ResearchNode): string | null {
  if (node.type === "exchange") return null;
  const editor = node.editedBy ?? null;
  return editor !== null && editor !== (node.authorId ?? null) ? editor : null;
}
