// Feeds: the sort and filter menu, a thread's row (the mockup's `rowHTML`),
// and a list of rows with Show more.

import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { ago } from "../data/format.js";
import {
  SORTS,
  sortRows,
  type KindFilter,
  type Row,
  type Sort,
  type Space,
} from "../data/spaces.js";
import { useNow } from "../sync/react.js";

import { Svg } from "./Svg.js";
import { Author, Avatar, SpaceTag } from "./atoms.js";
import { I } from "./icons.js";
import type { From } from "./nav.js";
import { useOverlay } from "./overlay.js";

const KF: [KindFilter, string, string][] = [
  ["all", "All", "Asks and posts"],
  ["ask", "Asks", "Answered by an agent"],
  ["post", "Posts", "Replies from people"],
];

export interface FeedState {
  sort: Sort;
  kind: KindFilter;
  setSort(s: Sort): void;
  setKind(k: KindFilter): void;
}

export function useFeedState(): FeedState {
  const [sort, setSort] = useState<Sort>("Latest");
  const [kind, setKind] = useState<KindFilter>("all");
  return { sort, kind, setSort, setKind };
}

export function SortControl({ f, withKind = true }: { f: FeedState; withKind?: boolean }) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const kl = withKind && f.kind !== "all" ? `${KF.find((k) => k[0] === f.kind)?.[1] ?? ""} · ` : "";
  return (
    <div className={`sortdd${withKind ? "sortdd-k" : ""}`}>
      <button
        aria-label="Sort and filter posts"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {kl}
        {f.sort}
        <Svg src={I.chev} />
      </button>
      {open ? (
        <div className="pop" role="menu">
          {withKind ? (
            <>
              <div className="grp eyebrow">Show</div>
              {KF.map(([k, l, d]) => (
                <button
                  key={k}
                  className="pop-row"
                  type="button"
                  role="menuitemradio"
                  aria-current={f.kind === k}
                  aria-checked={f.kind === k}
                  onClick={() => {
                    f.setKind(k);
                    setOpen(false);
                  }}
                >
                  {l}
                  <small>{d}</small>
                </button>
              ))}
              <div className="grp eyebrow">Sort</div>
            </>
          ) : null}
          {SORTS.map(([k, d]) => (
            <button
              key={k}
              className="pop-row"
              type="button"
              role="menuitemradio"
              aria-current={f.sort === k}
              aria-checked={f.sort === k}
              onClick={() => {
                f.setSort(k);
                setOpen(false);
              }}
            >
              {k}
              <small>{d}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One thread in a feed. `tag`: show its space (Home, Saved, search). */
export function FeedRow({
  p,
  space,
  tag,
  from,
}: {
  p: Row;
  space: Space | undefined;
  tag: boolean;
  from?: From;
}) {
  const now = useNow();
  const navigate = useNavigate();
  const ask = p.k === "ask";
  const n = p.n;
  const nLbl = `${n} ${ask ? (n === 1 ? "follow-up" : "follow-ups") : n === 1 ? "reply" : "replies"}`;
  const open = () => {
    if (!space) return;
    void navigate({
      to: "/s/$space/t/$thread",
      params: { space: space.name, thread: p.id },
      ...(from ? { state: { from } as never } : {}),
    });
  };
  const title =
    !ask && p.mod
      ? `Post ${p.mod} by a moderator.`
      : p.del
        ? `You deleted this ${ask ? "ask" : "post"}.`
        : p.q;
  return (
    // a click on the row opens it, as on the mockup; its title is the link
    // keyboard users take
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <article
      className={`row row-x row-rowsq row-i-lefttxt ${ask ? "row-ask" : "row-post"}`}
      role="listitem"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        open();
      }}
    >
      <span
        className="row-k"
        title={ask ? "Ask: answered by an agent" : "Post: replies from people"}
      >
        {ask ? (
          <span className="agent">
            <Svg src={I.agent} />
          </span>
        ) : (
          <Avatar u={p.u} className="sm" />
        )}
      </span>
      <div className="row-m">
        <a
          className={`row-t row-link${ask ? "" : "row-tp"}`}
          href={space ? `/s/${space.name}/t/${p.id}` : undefined}
          onClick={(e) => {
            e.preventDefault();
            open();
          }}
        >
          {title}
        </a>
        {ask ? (
          <span className="row-s">
            {p.running ? "Researching…" : p.mod ? `Answer ${p.mod} by a moderator.` : p.summary}
          </span>
        ) : null}
        <span className="row-meta">
          <Author u={p.u} />
          {tag && space ? (
            <button
              className="row-sp"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void navigate({ to: "/s/$space", params: { space: space.name } });
              }}
            >
              <SpaceTag s={space} />
            </button>
          ) : null}
          <span>{ago(p.createdAt, now)}</span>
          <span className="row-n num" aria-label={nLbl}>
            {n}
            <Svg src={I.reply} />
          </span>
        </span>
      </div>
    </article>
  );
}

/** A feed: its rows sorted and filtered, `page` at a time with Show more. */
export function Feed({
  rows,
  f,
  spaces,
  tag,
  page = 20,
  empty,
  from,
}: {
  rows: Row[];
  f: FeedState;
  spaces: Map<string, Space>;
  tag: boolean;
  page?: number;
  empty?: ReactNode;
  from?: From;
}) {
  const [shown, setShown] = useState(page);
  const list = sortRows(f.kind === "all" ? rows : rows.filter((p) => p.k === f.kind), f.sort);
  if (!list.length)
    return (
      empty ?? (
        <p className="muted fempty">
          No {f.kind === "ask" ? "asks" : f.kind === "post" ? "posts" : "threads"} here yet.
        </p>
      )
    );
  return (
    <>
      <div className="rows rows-plain" role="list">
        {list.slice(0, shown).map((p) => (
          <FeedRow key={p.id} p={p} space={spaces.get(p.s)} tag={tag} {...(from ? { from } : {})} />
        ))}
      </div>
      {list.length > shown ? (
        <div className="pg-more" aria-live="polite">
          <button className="btn sm pg-btn" type="button" onClick={() => setShown((n) => n + page)}>
            Show more
          </button>
        </div>
      ) : null}
    </>
  );
}
