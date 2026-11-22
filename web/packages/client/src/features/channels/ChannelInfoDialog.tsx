// The channel's info dialog (02 W6.2; the mock's `chInfoDlg`) and the About
// editor stacked over it (W6.3, `chEditDlg`). The info dialog: glyph,
// `#name`, the lock, Edit (owner) and Close; the frozen-channel banner (W6.10);
// the description, or for an owner without one "No description yet." with
// "Add one"; the facts "Channel by" ("Deleted account" for a frozen
// channel, whose owner's account was deleted), "Members" (a button opening
// the member list, W6.8), "Visibility"; for the owner, "Moderation log" (W6.4)
// and, in a private channel, "Invite to #name" (W6.9). The editor: "About" with a live "N / 300" counter,
// Cancel and Save (`spaces.update`), the toast "Channel updated." and focus
// back on Edit. Escape closes the editor first, then the info dialog (02
// W10.2).

import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";

import { useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { useNow, type ChannelView } from "../../replica/queries.js";
import { UNKNOWN, known } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { Avatar, ChannelGlyph } from "../../ui/Avatar.js";
import { useFeedViewer } from "../feed/FeedContext.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { relTime } from "../feed/format.js";
import { CloseIcon, LockIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

import { InviteLinksDialog } from "./InviteLinksDialog.js";
import { MembersDialog } from "./MembersDialog.js";

/** The banner of a frozen channel (04 B6, 02 W6.10). */
export function frozenBanner(name: string): string {
  return `#${name} is frozen: its owner’s account is not active. You can read it and delete your own posts.`;
}

export function FrozenBanner({ name }: { name: string }) {
  return (
    <p className="frozen-banner" role="note">
      {frozenBanner(name)}
    </p>
  );
}

export const DESC_MAX = 300;

export function ChannelInfoDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [log, setLog] = useState(false);
  const [members, setMembers] = useState(false);
  const [links, setLinks] = useState(false);
  const { me } = useFeedViewer();
  const logButton = useRef<HTMLButtonElement>(null);
  const membersButton = useRef<HTMLButtonElement>(null);
  const linksButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const owner = channel.owned && !channel.frozen;
  return (
    <FeedDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setEditing(false);
        onOpenChange(next);
      }}
      labelledBy="ci-h"
      className="chdlg"
      initialFocus={closeButton}
    >
      <div className="chdlg-h">
        <ChannelGlyph name={channel.name} size="xl" className="glyph" />
        <h3 id="ci-h">
          #{channel.name}
          {channel.private ? <LockIcon /> : null}
        </h3>
        {owner ? (
          <button
            ref={editButton}
            type="button"
            className="btn2 sm"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : null}
        <Dialog.Close ref={closeButton} className="ibtn" aria-label="Close">
          <CloseIcon />
        </Dialog.Close>
      </div>
      {channel.frozen ? <FrozenBanner name={channel.name} /> : null}
      {channel.desc ? (
        <p>{channel.desc}</p>
      ) : owner ? (
        <p className="chnone">
          No description yet.{" "}
          <button type="button" className="tlink inl" onClick={() => setEditing(true)}>
            Add one
          </button>
        </p>
      ) : null}
      <dl className="chfacts">
        <dt>Channel by</dt>
        <dd>
          {channel.frozen ? (
            "Deleted account"
          ) : (
            <>
              <Avatar handle={channel.owner} size="xs" />@{channel.owner}
            </>
          )}
        </dd>
        <dt>Members</dt>
        <dd>
          {/* a private channel's members are its members' to read: anyone
              else gets the count only */}
          {channel.private && !channel.joined ? (
            channel.members
          ) : (
            <button
              ref={membersButton}
              type="button"
              className="tlink inl"
              aria-label={`Members, ${channel.members}`}
              onClick={() => setMembers(true)}
            >
              {channel.members}
            </button>
          )}
        </dd>
        <dt>Visibility</dt>
        <dd>
          {channel.private
            ? "Private: only members can read or post"
            : "Open: anyone can read and join"}
        </dd>
      </dl>
      {owner ? (
        <div className="chfoot">
          <button ref={logButton} type="button" className="tlink" onClick={() => setLog(true)}>
            Moderation log
          </button>
          {channel.private ? (
            <button
              ref={linksButton}
              type="button"
              className="tlink"
              onClick={() => setLinks(true)}
            >
              Invite to #{channel.name}
            </button>
          ) : null}
        </div>
      ) : null}
      <MembersDialog
        channel={channel}
        me={me}
        open={members}
        onOpenChange={setMembers}
        returnFocus={membersButton}
      />
      {owner && channel.private ? (
        <InviteLinksDialog
          channel={channel}
          open={links}
          onOpenChange={setLinks}
          returnFocus={linksButton}
        />
      ) : null}
      {owner ? (
        <AboutEditorDialog
          channel={channel}
          open={editing}
          onOpenChange={setEditing}
          returnFocus={editButton}
        />
      ) : null}
      {owner ? (
        <ModerationLogDialog
          channel={channel}
          open={log}
          onOpenChange={setLog}
          returnFocus={logButton}
        />
      ) : null}
    </FeedDialog>
  );
}

/** The owner's removals and bans, newest first (02 W6.4; the mock's
 * `modLogDlg`), stacked over the info dialog. No removed text: the removal
 * erased it (01 C12). */
export function ModerationLogDialog({
  channel,
  open,
  onOpenChange,
  returnFocus,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const now = useNow();
  const close = useRef<HTMLButtonElement>(null);
  const entries = useReplicaQuery(
    (source) =>
      [...known(source.list("modlog", { sp: channel.id }))].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      ),
    [channel.id],
  );
  const list = entries === UNKNOWN ? [] : entries;
  return (
    <FeedDialog
      open={open}
      onOpenChange={onOpenChange}
      labelledBy="ml-h"
      className="chdlg cedlg mldlg"
      stacked
      initialFocus={close}
      finalFocus={returnFocus}
    >
      <div className="chdlg-h">
        <ChannelGlyph name={channel.name} size="xl" className="glyph" />
        <h3 id="ml-h">Moderation log</h3>
        <Dialog.Close ref={close} className="ibtn" aria-label="Close">
          <CloseIcon />
        </Dialog.Close>
      </div>
      <div className="cebody">
        {list.length === 0 ? (
          <p className="chnone">
            Nothing removed yet. Use “Remove…” in a thread&apos;s “…” menu to take it down.
          </p>
        ) : (
          <ul className="mlist">
            {list.map((m) => {
              const ban = m.act !== "remove";
              const what = m.item?.startsWith("p:") ? "post" : "ask";
              return (
                <li key={m.id}>
                  <span className={ban ? "mlkind ban" : "mlkind rm"}>
                    {m.act === "remove" ? "Removed" : m.act === "ban" ? "Banned" : "Unbanned"}
                  </span>
                  <span className="mltext">
                    {m.act === "remove"
                      ? `@${m.by} removed @${m.author}'s ${what}`
                      : m.act === "ban"
                        ? `@${m.by} banned @${m.author} from #${channel.name}`
                        : `@${m.by} unbanned @${m.author} from #${channel.name}`}
                    {m.note ? <small>Reason: “{m.note}”</small> : null}
                    <small>{relTime(m.createdAt, now)}</small>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FeedDialog>
  );
}

export function AboutEditorDialog({
  channel,
  open,
  onOpenChange,
  returnFocus,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const writes = useWrites();
  const field = useRef<HTMLTextAreaElement>(null);
  const [desc, setDesc] = useState(channel.desc);
  const [error, setError] = useState("");
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if (open) {
      setDesc(channel.desc);
      setError("");
    }
  }
  const save = async () => {
    if (desc.trim().length > DESC_MAX) {
      setError(`Keep the description under ${DESC_MAX} characters.`);
      return;
    }
    if (await writes.updateAbout(channel.id, desc.trim())) {
      onOpenChange(false);
      showToast("Channel updated.");
    }
  };
  return (
    <FeedDialog
      open={open}
      onOpenChange={onOpenChange}
      labelledBy="ce-h"
      className="chdlg cedlg"
      stacked
      initialFocus={field}
      finalFocus={returnFocus}
    >
      <div className="chdlg-h">
        <ChannelGlyph name={channel.name} size="xl" className="glyph" />
        <h3 id="ce-h">Edit #{channel.name}</h3>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="pform"
      >
        <div className="cebody">
          <label>
            About
            <textarea
              ref={field}
              rows={4}
              maxLength={DESC_MAX}
              placeholder="What the channel is for. Shown at the top of the channel."
              value={desc}
              onChange={(event) => setDesc(event.target.value)}
            />
            <small className="cecount">
              {desc.length} / {DESC_MAX}
            </small>
          </label>
          {error ? <p className="ferr">{error}</p> : null}
        </div>
        <div className="dacts">
          <button type="button" className="btn2" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn1">
            Save
          </button>
        </div>
      </form>
    </FeedDialog>
  );
}
