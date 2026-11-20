// Home (the mockup's `homeFeed`): the threads of the spaces the person
// joined, newest first, with the composer and the sort menu; on the right,
// their spaces and more spaces. Signed out, every open space's threads.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { count, spaceName } from "../data/format.js";
import { threadRows, type Space } from "../data/spaces.js";
import { useRecords } from "../sync/react.js";

import { Seal, SpaceGlyph } from "./atoms.js";
import { Composer } from "./Composer.js";
import { Feed, SortControl, useFeedState } from "./Feed.js";
import { SVG } from "./icons.js";
import { Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { useWorld } from "./world.js";

function SpaceRow({ s }: { s: Space }) {
  const navigate = useNavigate();
  return (
    <button
      className="sp-row"
      type="button"
      onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
    >
      <SpaceGlyph s={s} />
      <span className="cs-nmrow">
        {spaceName(s)}
        <Seal s={s} size="sm" />
      </span>
      {s.posts !== null ? <small className="num">{count(s.posts)}</small> : null}
    </button>
  );
}

function HomeSide() {
  const w = useWorld();
  const navigate = useNavigate();
  const joined = Object.keys(w.roles).flatMap((id) => w.byId.get(id) ?? []);
  const others = w.spaces.filter((s) => w.roles[s.id] === undefined && s.vis !== "unlisted");
  const more = joined.length ? others.filter((s) => s.vis === "open").slice(0, 4) : others;
  const byActivity = (a: Space, b: Space) => (b.posts ?? 0) - (a.posts ?? 0);
  return (
    <aside className="drawer wk home-side" aria-label="Spaces">
      <div className="dbody">
        {joined.length ? (
          <div className="note-card">
            <div className="sk-head">
              <h3>Your spaces</h3>
            </div>
            <div className="sp-rows">
              {joined.map((s) => (
                <SpaceRow key={s.id} s={s} />
              ))}
            </div>
          </div>
        ) : null}
        <div className="note-card">
          <div className="sk-head">
            <h3>{joined.length ? "More spaces" : "Spaces"}</h3>
            <button className="tlink" type="button" onClick={() => void navigate({ to: "/spaces/browse" })}>
              Browse all
            </button>
          </div>
          <div className="sp-rows">
            {[...more].sort(byActivity).map((s) => (
              <SpaceRow key={s.id} s={s} />
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function HomeEmpty() {
  const navigate = useNavigate();
  return (
    <div className="cs-empty as-empty">
      <p>
        <b>Join a space to see its threads here</b>
      </p>
      <p className="muted">
        Threads from the spaces you join show on Home, newest first. You can ask and post once you
        have joined a space.
      </p>
      <div className="as-empty-a">
        <button className="btn primary" type="button" onClick={() => void navigate({ to: "/spaces/browse" })}>
          Browse spaces
        </button>
        <button className="btn" type="button" onClick={() => void navigate({ to: "/spaces/new" })}>
          <Svg src={SVG.PLUS} />
          Create a space
        </button>
      </div>
    </div>
  );
}

export function HomePage() {
  const w = useWorld();
  const f = useFeedState();
  const out = !w.me;
  // the spaces Home shows: the person's, or (signed out) every open space
  const ids = useMemo(
    () =>
      out
        ? w.spaces.filter((s) => s.vis === "open").map((s) => s.id)
        : w.spaces.filter((s) => w.roles[s.id] !== undefined).map((s) => s.id),
    [out, w.spaces, w.roles],
  );
  const session = w.session;
  useEffect(() => {
    if (out) for (const id of ids) void session?.showSpace(id);
  }, [out, ids, session]);
  const key = ids.join(",");
  const rows = useRecords((r) => threadRows(r, new Set(ids)), [key]) ?? [];
  const empty = !out && w.loaded && ids.length === 0;
  return (
    <Page place={{ kind: "home" }}>
      <div className="body home-feed">
        <div className="mcol">
          <div className="main">
            <div className="home-head">
              <h2>{out ? "Everything on Session" : "Home"}</h2>
              <p>{out ? "New threads from every public space." : "New threads from the spaces you joined."}</p>
            </div>
            {empty ? (
              <HomeEmpty />
            ) : (
              <>
                <Composer space={null} />
                <div className="fbar fbar-k">
                  <SortControl f={f} />
                </div>
                <Feed rows={rows} f={f} spaces={w.byId} tag page={20} from={{ label: "Home", to: "/" }} />
              </>
            )}
          </div>
        </div>
        <HomeSide />
      </div>
    </Page>
  );
}
