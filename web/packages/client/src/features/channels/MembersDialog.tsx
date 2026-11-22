// The member list (02 W6.8, 04 §4.3, §6.4; a plan addition), stacked over
// the channel's info dialog: the owner, then members by the date they
// joined. The owner gets a "…" menu on every other member: "Ban from
// #name", and in a private channel "Remove from channel", each confirmed
// first in a dialog that names the person and the channel. A removal sends
// `members.remove` with the admission id the owner saw: a person let in
// again since answers STALE, the toast says so and the row shows the member
// as they are now; a person who had already left answers `removed: false`,
// and the toast says that instead of a removal.
// Under the list the owner sees who is banned, each with Unban. There are no
// role controls: a channel has only its owner and members (01 C18).

import { Dialog } from "@base-ui/react/dialog";
import type { BanRec, MemberRec } from "@session/mutators";
import { useRef, useState } from "react";

import { useReplicaQuery } from "../../replica/ReplicaProvider.js";
import type { ChannelView } from "../../replica/queries.js";
import { UNKNOWN, known, loose } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { Avatar, ChannelGlyph } from "../../ui/Avatar.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { MoreMenu, type MoreAction } from "../feed/MoreMenu.js";
import { CloseIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

import { ConfirmMemberAction, type MemberAction } from "./ConfirmMemberAction.js";

/** The owner first, then members by the time they joined. */
export function memberOrder(members: readonly MemberRec[]): MemberRec[] {
  return [...members].sort((a, b) =>
    a.role !== b.role
      ? a.role === "owner"
        ? -1
        : 1
      : a.joinedAt === b.joinedAt
        ? a.u < b.u
          ? -1
          : 1
        : a.joinedAt < b.joinedAt
          ? -1
          : 1,
  );
}

/** The actions the viewer has on a member's row: none unless the viewer owns
 * the channel and the row is someone else's. */
export function memberActions(
  channel: Pick<ChannelView, "owned" | "private" | "name" | "frozen">,
  member: Pick<MemberRec, "u" | "role">,
  me: string | null,
): string[] {
  if (!channel.owned || channel.frozen || member.u === me || member.role === "owner") return [];
  return channel.private
    ? [`Ban from #${channel.name}`, "Remove from channel"]
    : [`Ban from #${channel.name}`];
}

/** The toast of an applied removal: `members.remove` answers `removed:
 * false` when the person was no longer a member, and nothing changed. */
export function removalToast(result: unknown, user: string, channel: string): string {
  const removed = (result as { removed?: unknown } | null)?.removed;
  return removed === false
    ? `@${user} had already left #${channel}.`
    : `Removed @${user} from #${channel}.`;
}

export function MembersDialog({
  channel,
  me,
  open,
  onOpenChange,
  returnFocus,
}: {
  channel: ChannelView;
  me: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const writes = useWrites();
  const close = useRef<HTMLButtonElement>(null);
  const members = useReplicaQuery(
    (source) => memberOrder(known(source.list("member", { sp: channel.id }))),
    [channel.id],
  );
  const bans = useReplicaQuery(
    (source) =>
      channel.owned
        ? [...(loose(source.list("ban", { sp: channel.id })) ?? [])].sort((a, b) =>
            a.createdAt < b.createdAt ? 1 : -1,
          )
        : [],
    [channel.id, channel.owned],
  );

  const ban = async (user: string) => {
    const o = await writes.send("members.ban", { space: channel.id, user });
    if (o.ok && !o.unsent) showToast(`Banned @${user} from #${channel.name}.`);
  };
  const remove = async (m: MemberRec) => {
    const o = await writes.send("members.remove", {
      space: channel.id,
      user: m.u,
      base: { adm: m.adm },
    });
    if (o.ok && !o.unsent) showToast(removalToast(o.result, m.u, channel.name));
  };
  const unban = async (b: BanRec) => {
    const o = await writes.send("members.unban", { space: channel.id, user: b.u });
    if (o.ok && !o.unsent) showToast(`Unbanned @${b.u}.`);
  };

  // Ban and Remove ask first; the removal keeps the admission id the owner
  // saw when they chose it
  const [asking, setAsking] = useState<{ action: MemberAction; member: MemberRec } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ask = (action: MemberAction, member: MemberRec) => {
    setAsking({ action, member });
    setConfirmOpen(true);
  };
  const actionsOf = (m: MemberRec): MoreAction[] =>
    memberActions(channel, m, me).map((label) =>
      label === "Remove from channel"
        ? { label, danger: true, onSelect: () => ask("remove", m) }
        : { label, danger: true, onSelect: () => ask("ban", m) },
    );

  const menus = members !== UNKNOWN && members.some((m) => actionsOf(m).length > 0);

  return (
    <FeedDialog
      open={open}
      onOpenChange={onOpenChange}
      labelledBy="mb-h"
      className="chdlg cedlg mbdlg"
      stacked
      initialFocus={close}
      finalFocus={returnFocus}
    >
      <div className="chdlg-h">
        <ChannelGlyph name={channel.name} size="xl" className="glyph" />
        <h3 id="mb-h">Members of #{channel.name}</h3>
        <Dialog.Close ref={close} className="ibtn" aria-label="Close">
          <CloseIcon />
        </Dialog.Close>
      </div>
      <div className="cebody">
        {members === UNKNOWN ? (
          <p className="chnone" role="status" aria-busy="true">
            Loading members…
          </p>
        ) : (
          <ul className="mlist mblist" aria-label="Members">
            {members.map((m) => {
              // the badges end where the "…" menu starts: a row without a
              // menu keeps its place empty when other rows have one
              const actions = actionsOf(m);
              return (
                <li key={m.u} data-member={m.u}>
                  <Avatar handle={m.u} size="sm" />
                  <span className="mltext">@{m.u}</span>
                  {m.u === me || m.role === "owner" ? (
                    <span className="mlbadges">
                      {m.u === me ? <span className="chip">You</span> : null}
                      {m.role === "owner" ? <span className="chip">Owner</span> : null}
                    </span>
                  ) : null}
                  {actions.length > 0 ? (
                    <MoreMenu actions={actions} inDialog />
                  ) : menus ? (
                    <span className="mlmore" aria-hidden="true" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {channel.owned && bans !== UNKNOWN ? (
          <section aria-labelledby="mb-banned">
            <h4 id="mb-banned" className="mbhead">
              Banned
            </h4>
            {bans.length === 0 ? (
              <p className="chnone">Nobody is banned from #{channel.name}.</p>
            ) : (
              <ul className="mlist" aria-label="Banned">
                {bans.map((b) => (
                  <li key={b.u} data-banned={b.u}>
                    <Avatar handle={b.u} size="sm" />
                    <span className="mltext">@{b.u}</span>
                    <button type="button" className="btn2 sm" onClick={() => void unban(b)}>
                      Unban
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
      {asking ? (
        <ConfirmMemberAction
          action={asking.action}
          user={asking.member.u}
          channel={channel}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={() =>
            void (asking.action === "ban" ? ban(asking.member.u) : remove(asking.member))
          }
        />
      ) : null}
    </FeedDialog>
  );
}
