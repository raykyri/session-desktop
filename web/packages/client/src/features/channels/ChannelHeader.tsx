// The channel header (02 W6.1; the mock's `spaceHead`): glyph, `#name`, the
// lock of a private channel, the description clipped at 170 characters, the
// info button, and for writers one of "Your channel", "Joined" (leaves at
// once), "Members only" or Join. Its info dialog opens over the feed.

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { ChannelView } from "../../replica/queries.js";
import { useWrites } from "../../replica/writes.js";
import { ChannelGlyph } from "../../ui/Avatar.js";
import { useFeedViewer } from "../feed/FeedContext.js";
import { clip } from "../feed/format.js";
import { InfoIcon, LockIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

import { ChannelInfoDialog } from "./ChannelInfoDialog.js";

/** Join a channel, with the toast "Joined #name." */
export async function joinChannel(
  writes: ReturnType<typeof useWrites>,
  channel: { id: string; name: string },
) {
  if (await writes.join(channel.id)) showToast(`Joined #${channel.name}.`);
}

export function ChannelHeader({ channel }: { channel: ChannelView }) {
  const { writer } = useFeedViewer();
  const writes = useWrites();
  const navigate = useNavigate();
  const [info, setInfo] = useState(false);
  const infoButton = useRef<HTMLButtonElement>(null);

  const leave = async () => {
    if (!(await writes.leave(channel.id))) return;
    showToast(`Left #${channel.name}.`);
    // Leaving a private channel goes Home; an open one stays on its feed.
    if (channel.private) void navigate({ to: "/", search: {} });
  };

  let action = null;
  if (writer) {
    if (channel.owned) action = <span className="chip">Your channel</span>;
    else if (channel.joined)
      action = (
        <button type="button" className="btn2 sm" onClick={() => void leave()}>
          Joined
        </button>
      );
    else if (channel.private) action = <span className="chip">Members only</span>;
    else if (!channel.frozen)
      action = (
        <button type="button" className="btn1 sm" onClick={() => void joinChannel(writes, channel)}>
          Join
        </button>
      );
  }

  return (
    <div className="sphead">
      <div className="grow">
        <h2 tabIndex={-1} data-channel-heading="">
          <ChannelGlyph name={channel.name} size="lg" />#{channel.name}
          {channel.private ? <LockIcon /> : null}
        </h2>
        {channel.desc ? <p>{clip(channel.desc, 170)}</p> : null}
      </div>
      <button
        ref={infoButton}
        type="button"
        className="ibtn chinfo"
        aria-label="About this channel"
        title="About this channel"
        onClick={() => setInfo(true)}
      >
        <InfoIcon />
      </button>
      {action}
      <ChannelInfoDialog channel={channel} open={info} onOpenChange={setInfo} />
    </div>
  );
}
