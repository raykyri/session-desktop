// Who else has the thread open (web only): small avatars in the thread's
// header, from `research.presence.changed` and `events.presence`.

import type { ThreadViewer } from "@session/shared";

import { Avatar } from "./AuthorChip.js";
import { participantName } from "./context.js";

/** At most this many avatars; the rest are counted. */
const MAX_SHOWN = 4;

/** The viewers other than `meId`, in the order the server lists them. */
export function otherViewers(
  viewers: readonly ThreadViewer[],
  meId: string | null,
): ThreadViewer[] {
  return viewers.filter((viewer) => viewer.userId !== meId);
}

export function PresenceAvatars({
  viewers,
  meId,
}: {
  viewers: readonly ThreadViewer[];
  meId: string | null;
}) {
  const others = otherViewers(viewers, meId);
  if (others.length === 0) return null;
  const names = others.map(participantName);
  const label = `Also viewing: ${names.join(", ")}`;
  const shown = others.slice(0, MAX_SHOWN);
  const extra = others.length - shown.length;
  return (
    <span
      className="flex shrink-0 items-center -space-x-1"
      role="img"
      aria-label={label}
      title={label}
      data-research-presence=""
    >
      {shown.map((viewer) => (
        <Avatar
          key={viewer.userId}
          person={viewer}
          size={18}
          className="ring-2 ring-[var(--research-thread-page-bg)]"
        />
      ))}
      {extra > 0 ? (
        <span className="text-fg-muted pl-2 text-xs tabular-nums" aria-hidden="true">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
