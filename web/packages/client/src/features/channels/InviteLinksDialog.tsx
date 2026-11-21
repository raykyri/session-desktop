// "Invite to #name" (02 W6.9, 04 B4; a plan addition), stacked over the info
// dialog of a private channel, for its owner: one-use links that expire in 7
// days, `<origin>/c/<name>#<code>`, with Copy and Revoke, and Undo on a
// revoked one. The server makes each code (`invites.create`, `pre`); the
// owner's replica holds the link records, the codes included, and no other
// reader gets them. A used link names who used it, so the owner can remove
// or ban that person.

import { Dialog } from "@base-ui/react/dialog";
import { isoToMs, type InviteRec } from "@session/mutators";
import { useRef, useState } from "react";

import { writeClipboardText } from "../../lib/clipboard.js";
import { PUBLIC_ORIGIN } from "../../lib/publicOrigin.js";
import { useReplica, useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { useNow, type ChannelView } from "../../replica/queries.js";
import { UNKNOWN, loose } from "../../replica/source.js";
import { newUlid } from "../../replica/ulid.js";
import { useWrites } from "../../replica/writes.js";
import { ChannelGlyph } from "../../ui/Avatar.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { CloseIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

/** How long a channel invite link works (04 B4). */
export const CHANNEL_LINK_DAYS = 7;

/** A channel invite link: the channel's address with the code in the
 * fragment, which no request carries. */
export function channelInviteLink(name: string, code: string, origin = PUBLIC_ORIGIN): string {
  return `${origin}/c/${name}#${code}`;
}

export type LinkState = "open" | "used" | "revoked" | "expired";

export function linkState(link: InviteRec, now: number): LinkState {
  if (link.dead === "Used") return "used";
  if (link.dead !== null) return "revoked";
  return isoToMs(link.expiresAt) <= now ? "expired" : "open";
}

export function InviteLinksDialog({
  channel,
  open,
  onOpenChange,
  returnFocus,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const source = useReplica();
  const writes = useWrites();
  const now = useNow();
  const close = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const links = useReplicaQuery(
    (s) =>
      [...(loose(s.list("invite", { sp: channel.id })) ?? [])].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      ),
    [channel.id],
  );
  const list = links === UNKNOWN ? [] : links.filter((l) => linkState(l, now) !== "expired");

  const create = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await writes.send("invites.create", {
      id: newUlid(source.now()),
      space: channel.id,
      days: CHANNEL_LINK_DAYS,
    });
    setBusy(false);
    if (outcome.ok && !outcome.unsent) showToast("Invite link created.");
  };
  const copy = (code: string) =>
    void writeClipboardText(channelInviteLink(channel.name, code)).then(() =>
      showToast("Link copied."),
    );
  const revoke = async (id: string) => {
    const o = await writes.send("invites.revoke", { id });
    if (o.ok && !o.unsent) showToast("Link revoked.");
  };
  const restore = async (id: string) => {
    const o = await writes.send("invites.restore", { id });
    if (o.ok && !o.unsent) showToast("Link restored.");
  };

  return (
    <FeedDialog
      open={open}
      onOpenChange={onOpenChange}
      labelledBy="il-h"
      className="chdlg cedlg ildlg"
      stacked
      initialFocus={close}
      finalFocus={returnFocus}
    >
      <div className="chdlg-h">
        <ChannelGlyph name={channel.name} size="xl" className="glyph" />
        <h3 id="il-h">Invite to #{channel.name}</h3>
        <Dialog.Close ref={close} className="ibtn" aria-label="Close">
          <CloseIcon />
        </Dialog.Close>
      </div>
      <div className="cebody">
        <p className="cefine">
          A private channel admits people only by invite link. Each link works for one person and
          expires after {CHANNEL_LINK_DAYS} days.
        </p>
        {list.length ? (
          <ul className="mlist ilist" aria-label="Invite links">
            {list.map((l) => {
              const state = linkState(l, now);
              return (
                <li key={l.id} data-link={l.id} data-state={state}>
                  <span>
                    <code className="ilink">{channelInviteLink(channel.name, l.code)}</code>
                    <small>
                      {state === "used"
                        ? `Used by @${l.usedBy ?? ""}`
                        : state === "revoked"
                          ? "Revoked"
                          : `Expires ${new Date(isoToMs(l.expiresAt)).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )}`}
                    </small>
                  </span>
                  {state === "open" ? (
                    <>
                      <button type="button" className="btn2 sm" onClick={() => copy(l.code)}>
                        Copy
                      </button>
                      <button
                        type="button"
                        className="btn2 sm"
                        aria-label="Revoke this link"
                        title="Revoke"
                        onClick={() => void revoke(l.id)}
                      >
                        Revoke
                      </button>
                    </>
                  ) : state === "revoked" ? (
                    <button type="button" className="btn2 sm" onClick={() => void restore(l.id)}>
                      Undo
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div>
          <button
            type="button"
            className="btn1 sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void create()}
          >
            Create an invite link
          </button>
        </div>
      </div>
    </FeedDialog>
  );
}
