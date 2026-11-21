// Browse channels (02 W6.6; the mock's `browsePage`): "Browse channels" with
// New channel for writers, a search over names and descriptions, and a card
// per channel: glyph, `#name`, lock, "by @owner · N members", the
// description clipped at 120, and Yours, Joined (leaves) or Join. Open
// channels, and the private ones the viewer is in.

import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { channelsOf, type ChannelView } from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { ChannelGlyph } from "../../ui/Avatar.js";
import { useFeedViewer } from "../feed/FeedContext.js";
import { clip, noun } from "../feed/format.js";
import { LockIcon, SearchIcon } from "../feed/icons.js";
import { PageFrame } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";

import { joinChannel } from "./ChannelHeader.js";
import { useNewChannelDialog } from "./NewChannelDialog.js";

/** The channels Browse lists for a query. */
export function browseList(channels: readonly ChannelView[], query: string): ChannelView[] {
  const q = query.trim().toLowerCase();
  return channels.filter(
    (c) =>
      (!c.private || c.joined) && (!q || c.name.includes(q) || c.desc.toLowerCase().includes(q)),
  );
}

export function BrowsePage() {
  const { writer } = useFeedViewer();
  const writes = useWrites();
  const openNew = useNewChannelDialog((state) => state.setOpen);
  const [query, setQuery] = useState("");
  const channels = useReplicaQuery(channelsOf, []);
  const list = channels === UNKNOWN ? [] : browseList(channels, query);

  return (
    <PageFrame
      title="Browse channels"
      narrow
      action={
        writer ? (
          <button type="button" className="btn1 sm" onClick={() => openNew(true)}>
            New channel
          </button>
        ) : null
      }
    >
      <label className="sfind">
        <SearchIcon />
        <input
          value={query}
          placeholder="Search channels"
          aria-label="Search channels"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {channels === UNKNOWN ? (
        <p className="page-empty" role="status" aria-label="Loading" aria-busy="true" />
      ) : list.length === 0 ? (
        <p className="page-empty">No channels match.</p>
      ) : (
        <div className="bgrid">
          {list.map((c) => (
            <div key={c.id} className="bcard">
              <Link to="/c/$name" params={{ name: c.name }} search={{}} className="bopen">
                <ChannelGlyph name={c.name} size="xxl" />
                <span>
                  <b>
                    #{c.name}
                    {c.private ? <LockIcon /> : null}
                  </b>
                  <small>
                    by @{c.owner} · {noun(c.members, "member", "members")}
                  </small>
                </span>
              </Link>
              <p>{clip(c.desc, 120)}</p>
              {!writer ? null : c.owned ? (
                <span className="chip">Yours</span>
              ) : c.joined ? (
                <button
                  type="button"
                  className="btn2 sm"
                  onClick={() =>
                    void writes.leave(c.id).then((ok) => ok && showToast(`Left #${c.name}.`))
                  }
                >
                  Joined
                </button>
              ) : (
                <button
                  type="button"
                  className="btn1 sm"
                  onClick={() => void joinChannel(writes, c)}
                >
                  Join
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </PageFrame>
  );
}
