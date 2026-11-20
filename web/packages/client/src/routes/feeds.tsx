// The feed screens (02 §2.1, §3.1): Home, a channel and Saved. Their rows,
// the channel header and the composer read the replica (02 §9) and are built
// with W3.1-W6.1; until then each feed is the layout frame with one
// placeholder row, so the shell, the bar's alignment and the footer are in
// place.

import { FeedFrame, FeedPlaceholder } from "../features/shell/Frames.js";

export function HomeFeedPage() {
  return (
    <FeedFrame>
      <FeedPlaceholder />
    </FeedFrame>
  );
}

export function ChannelFeedPage() {
  return (
    <FeedFrame>
      <FeedPlaceholder />
    </FeedFrame>
  );
}

export function SavedFeedPage() {
  return (
    <FeedFrame>
      <FeedPlaceholder />
    </FeedFrame>
  );
}
