// The sentences an owner's Delete, Move to Trash and Make private
// confirmations add when the thread is shared (web only;
// `10-home-feed-journal.md` §4b). The owner's Trash hides the thread from
// its members until it is restored, and Delete removes what they added with
// it; making a public thread private leaves members their access.

import { useThreadMembers } from "../../api/queries.js";

/** How many people the reader's own thread is shared with (its members, not
 * the owner); 0 until the list loads, and 0 when `enabled` is false (a
 * thread shared with the reader, whose members are not managed by the reader). */
export function useOwnerMemberCount(treeId: string, enabled: boolean): number {
  const members = useThreadMembers(treeId, enabled).data;
  if (!enabled || !members) return 0;
  return members.filter((member) => member.role !== "owner").length;
}

function people(count: number): string {
  return count === 1 ? "The person it is shared with" : `The ${count} people it is shared with`;
}

/** Added to Move to Trash: members lose access while it is in the Trash. */
export function membersTrashSentence(count: number): string | null {
  if (count <= 0) return null;
  return `${people(count)} ${count === 1 ? "loses" : "lose"} access while it is in the Trash. The questions and notes they added go with it.`;
}

/** Added to Delete: members lose access and what they added is deleted. */
export function membersDeleteSentence(count: number): string | null {
  if (count <= 0) return null;
  return `${people(count)} ${count === 1 ? "loses" : "lose"} access, and the questions and notes they added are deleted with it.`;
}

/** Added to Make private: members keep their access. */
export function membersKeepAccessSentence(count: number): string | null {
  if (count <= 0) return null;
  return `${people(count)} ${count === 1 ? "keeps" : "keep"} access.`;
}

/** One of the sentences above as a paragraph of a confirmation's body, or
 * nothing. */
export function MembersWarning({ sentence }: { sentence: string | null }) {
  if (sentence === null) return null;
  return (
    <p className="m-0" data-members-warning="">
      {sentence}
    </p>
  );
}
