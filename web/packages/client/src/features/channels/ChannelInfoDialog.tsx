// The channel's info dialog (02 W6.2; the mock's `chInfoDlg`) and the About
// editor stacked over it (W6.3, `chEditDlg`). The info dialog: glyph,
// `#name`, the lock, Edit (owner) and Close; the description, or for an owner
// without one "No description yet." with "Add one"; the facts "Channel by",
// "Members", "Visibility". The moderation log and the member list are M6
// (W6.4, W6.8). The editor: "About" with a live "N / 300" counter, Cancel and
// Save (`spaces.update`), the toast "Channel updated." and focus back on
// Edit. Escape closes the editor first, then the info dialog (02 W10.2).

import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";

import type { ChannelView } from "../../replica/queries.js";
import { useWrites } from "../../replica/writes.js";
import { Avatar, ChannelGlyph } from "../../ui/Avatar.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { CloseIcon, LockIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

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
  const editButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const owner = channel.owned;
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
          <Avatar handle={channel.owner} size="xs" />@{channel.owner}
        </dd>
        <dt>Members</dt>
        <dd>{channel.members}</dd>
        <dt>Visibility</dt>
        <dd>
          {channel.private
            ? "Private: only members can read or post"
            : "Open: anyone can read and join"}
        </dd>
      </dl>
      {owner ? (
        <AboutEditorDialog
          channel={channel}
          open={editing}
          onOpenChange={setEditing}
          returnFocus={editButton}
        />
      ) : null}
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
