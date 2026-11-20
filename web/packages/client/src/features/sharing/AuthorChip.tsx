// A person's avatar and name (web only): who asked a question, wrote a note
// or saved a highlight in a shared thread, who has it open, who is a member.
// Shown only when the thread has more than one participant.

import type { ResearchParticipant } from "@session/shared";
import { useState } from "react";

import { cn } from "../../lib/cn.js";

import { participantName, useThreadCollaboration } from "./context.js";

type Person = Pick<ResearchParticipant, "login" | "name" | "avatarUrl">;

/** A round avatar; the person's initial when there is no picture or it does
 * not load. */
export function Avatar({
  person,
  size = 16,
  className,
}: {
  person: Person;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const name = participantName(person);
  const style = { width: size, height: size };
  if (person.avatarUrl && !failed) {
    return (
      <img
        className={cn("bg-surface-fill-medium shrink-0 rounded-full object-cover", className)}
        style={style}
        src={person.avatarUrl}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={cn(
        "bg-surface-fill-medium text-fg-secondary inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        className,
      )}
      style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.55)) }}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The name an author shows as: "You" for the reader, else their name; null
 * for an author not among the participants (their account is gone). */
export function useAuthorName(authorId: string | null | undefined): string | null {
  const { people } = useThreadCollaboration();
  if (!authorId) return null;
  if (authorId === people.meId) return "You";
  const person = people.byId.get(authorId);
  return person ? participantName(person) : null;
}

/**
 * Avatar and name of the person who wrote something, in a shared thread.
 * Renders nothing in a thread with one participant, or for an author the
 * thread no longer lists. `always` shows it in a single-person thread too.
 */
export function AuthorChip({
  authorId,
  className,
  prefix,
  always = false,
}: {
  authorId: string | null | undefined;
  className?: string;
  /** Text before the name ("Highlighted by"). */
  prefix?: string;
  always?: boolean;
}) {
  const { people } = useThreadCollaboration();
  const name = useAuthorName(authorId);
  if ((!people.shared && !always) || !authorId || name === null) return null;
  const person = people.byId.get(authorId);
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1 align-middle", className)}
      data-author-chip={authorId}
    >
      {person ? <Avatar person={person} size={14} /> : null}
      <span className="truncate">
        {prefix ? `${prefix} ` : ""}
        {name}
      </span>
    </span>
  );
}
