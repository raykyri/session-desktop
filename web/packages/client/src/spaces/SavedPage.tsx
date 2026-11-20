// Saved (the mockup's `layoutSaved`, list view): the threads the person saved,
// newest save first, filtered by space or searched.

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ago, spaceName } from "../data/format.js";
import { savedThreads, threadView } from "../data/spaces.js";
import { useNow, useRecords, useSession } from "../sync/react.js";

import { Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { Author, Glyph } from "./atoms.js";
import { I, MII, SVI } from "./icons.js";
import { BackRow } from "./nav.js";
import { useWorld } from "./world.js";

const PAGE = 20;

export function SavedPage() {
  const w = useWorld();
  const now = useNow();
  const session = useSession();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const items =
    useRecords(
      (r) =>
        savedThreads(r).flatMap(({ th }) => {
          const t = threadView(r, th);
          return t ? [{ id: t.id, s: t.s, u: t.u, q: t.q, sum: t.summary, at: t.createdAt }] : [];
        }),
      [],
    ) ?? [];
  // saved sources (srcsave), with what the spaces' copies say of them
  const sources =
    useRecords(
      (r) =>
        r
          .list("srcsave", (x) => x.u === r.me)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .flatMap((x) => {
            const m =
              r.list("spacesrc", (c) => c.src === x.src && !c.rm)[0]?.meta ??
              r.get("source", x.src)?.meta;
            return m
              ? [
                  {
                    id: x.src,
                    t: m.t ?? m.body[0]?.p ?? m.au,
                    by: [m.pl, m.au].filter(Boolean).join(" · "),
                    at: x.createdAt,
                  },
                ]
              : [];
          }),
      [],
    ) ?? [];
  const counts = new Map<string, number>();
  for (const x of items) counts.set(x.s, (counts.get(x.s) ?? 0) + 1);
  const needle = q.trim().toLowerCase();
  const list = items.filter(
    (x) =>
      (filter === "all" || x.s === filter) &&
      (!needle || `${x.q} ${x.sum ?? ""}`.toLowerCase().includes(needle)),
  );
  return (
    <Page place={{ kind: "saved" }}>
      <div className="home-wide sv-page svp-list">
        <BackRow />
        <div className="sv-top">
          <div className="sv-title">
            <h2>Saved</h2>
            <span className="faint num">
              {items.length} {items.length === 1 ? "thread" : "threads"}
            </span>
          </div>
          <label className="search sv-search">
            <Svg src={I.search} />
            <input
              id="nv-svq"
              type="search"
              placeholder="Search saved"
              aria-label="Search saved"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
            />
          </label>
        </div>
        <div className="sv-filters">
          <div className="sv-chips">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All <small className="num">{items.length}</small>
            </button>
            {sources.length ? (
              <button
                type="button"
                aria-pressed={filter === "mi-items"}
                onClick={() => setFilter("mi-items")}
              >
                Sources <small className="num">{sources.length}</small>
              </button>
            ) : null}
            {[...counts].map(([sp, n]) => {
              const s = w.byId.get(sp);
              return s ? (
                <button
                  key={sp}
                  type="button"
                  aria-pressed={filter === sp}
                  onClick={() => setFilter(sp)}
                >
                  {spaceName(s)} <small className="num">{n}</small>
                </button>
              ) : null;
            })}
          </div>
          <div className="seg sv-vsw">
            <button type="button" aria-pressed="true" aria-label="List view" title="List view">
              <Svg src={SVI.list ?? I.page} />
            </button>
            <button type="button" aria-pressed="false" aria-label="Reader view" title="Reader view">
              <Svg src={SVI.reader ?? I.book} />
            </button>
          </div>
        </div>
        {filter === "mi-items" ? (
          <div className="sv-list">
            {sources
              .filter((x) => !needle || `${x.t} ${x.by}`.toLowerCase().includes(needle))
              .map((x) => (
                <article className="sv-row" key={x.id}>
                  <span className="mi-ic mi-k-article">
                    <Svg src={MII.article} />
                  </span>
                  <div className="sv-body">
                    <div className="meta">
                      <span>{x.by}</span>
                      <span>{ago(x.at, now)}</span>
                    </div>
                    <p className="sv-q">
                      <a
                        className="row-link"
                        href={`/source/${x.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          void navigate({ to: "/source/$id", params: { id: x.id } });
                        }}
                      >
                        {x.t}
                      </a>
                    </p>
                  </div>
                </article>
              ))}
          </div>
        ) : items.length === 0 ? (
          <p className="muted sv-empty">
            Nothing saved yet. Use the bookmark on a thread, an ask or a source to keep it here.
          </p>
        ) : (
          <div className="sv-list">
            {list.slice(0, shown).map((x) => {
              const s = w.byId.get(x.s);
              const open = () =>
                s &&
                void navigate({
                  to: "/s/$space/t/$thread",
                  params: { space: s.name, thread: x.id },
                  state: { from: { label: "Saved", to: "/saved" } } as never,
                });
              return (
                <article className="sv-row" key={x.id} data-open={x.id}>
                  {s ? <Glyph s={s} /> : null}
                  <div className="sv-body">
                    <div className="meta">
                      <Author u={x.u} />
                      <span>{ago(x.at, now)}</span>
                    </div>
                    <p className="sv-q">
                      <a
                        className="row-link"
                        href={s ? `/s/${s.name}/t/${x.id}` : undefined}
                        onClick={(e) => {
                          e.preventDefault();
                          open();
                        }}
                      >
                        {x.q}
                      </a>
                    </p>
                    {x.sum ? <p className="sv-s">{x.sum}</p> : null}
                  </div>
                  <div className="sv-side">
                    {s ? (
                      <button
                        className="sp-tag"
                        type="button"
                        onClick={() =>
                          void navigate({ to: "/s/$space", params: { space: s.name } })
                        }
                      >
                        {spaceName(s)}
                      </button>
                    ) : null}
                    <button
                      className="iconbtn sv-x"
                      type="button"
                      aria-label="Remove from saved"
                      title="Remove from saved"
                      onClick={() =>
                        session?.write("saved.set", { kind: "thread", id: x.id, on: false })
                      }
                    >
                      <Svg src={I.close} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {list.length > shown ? (
          <div className="pg-more" aria-live="polite">
            <button
              className="btn sm pg-btn"
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
            >
              Show more
            </button>
          </div>
        ) : null}
      </div>
    </Page>
  );
}
