// The feed screens (02 §2.1, §3.1): Home, a channel and Saved, each with the
// thread address in its search (`?t=&sel=`).

import { getRouteApi } from "@tanstack/react-router";

import { FeedPage } from "../features/feed/FeedPage.js";

const home = getRouteApi("/_shell/");
const channel = getRouteApi("/_shell/c/$name");
const saved = getRouteApi("/_shell/saved");

export function HomeFeedPage() {
  const { t, sel } = home.useSearch();
  return <FeedPage kind="home" t={t} sel={sel} />;
}

export function ChannelFeedPage() {
  const { name } = channel.useParams();
  const { t, sel } = channel.useSearch();
  return <FeedPage key={name} kind="channel" name={name} t={t} sel={sel} />;
}

export function SavedFeedPage() {
  const { t, sel } = saved.useSearch();
  return <FeedPage kind="saved" t={t} sel={sel} />;
}
