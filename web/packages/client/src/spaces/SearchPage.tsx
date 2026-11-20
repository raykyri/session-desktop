// Search (the mockup's `layoutSearch`): the threads, the asks inside threads
// and the sources the reader can read whose text matches, with the matching
// spaces in a side column. It searches the records this tab holds: the
// person's spaces, and the spaces it has shown.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ago, fmt, plainText, spaceName } from "../data/format.js";
import type { Space } from "../data/spaces.js";
import { useNow, useRecords } from "../sync/react.js";
import type { Reader } from "../sync/reader.js";

import { Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { Author, Seal, SpaceGlyph, SpaceTag } from "./atoms.js";
import { I } from "./icons.js";
import { BackRow } from "./nav.js";
import { canRead, useWorld } from "./world.js";

const CAP = 4;

/** The query's stem, as the mockup matches: "replications" finds
 * "replication". */
export const stemOf = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/(ions|ion|s)$/, "");

/** `text` with each match of `stem` marked. */
export function highlight(text: string, stem: string): ReactNode[] {
  if (!stem) return [text];
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let k = lower.indexOf(stem); k >= 0; k = lower.indexOf(stem, k + stem.length)) {
    out.push(text.slice(at, k));
    out.push(
      <mark className="sr-m" key={k}>
        {text.slice(k, k + stem.length)}
      </mark>,
    );
    at = k + stem.length;
  }
  out.push(text.slice(at));
  return out;
}

/** A short excerpt around the first match, cut at word boundaries. */
export function excerpt(src: string, stem: string): string {
  const k = src.toLowerCase().indexOf(stem);
  if (k < 0) return src.length > 160 ? `${src.slice(0, 160)}…` : src;
  let a = Math.max(0, k - 60);
  let b = Math.min(src.length, k + 110);
  if (a) {
    const w = src.indexOf(" ", a);
    if (w > -1 && w < k) a = w + 1;
  }
  if (b < src.length) {
    const w = src.lastIndexOf(" ", b);
    if (w > k) b = w;
  }
  return (a ? "…" : "") + src.slice(a, b).trim() + (b < src.length ? "…" : "");
}

/** Markdown as plain text for matching: links and markers dropped. */
const plain = (md: string | null) => plainText(md ?? "");

interface Hit {
  id: string;
  s: string;
  u: string;
  q: string;
  ex: string;
  at: string;
  n: number;
  k: "ask" | "post";
}

interface AskHit {
  th: string;
  node: string;
  s: string;
  u: string;
  q: string;
  ex: string;
  at: string;
  level: number;
  title: string;
}

function search(r: Reader, stem: string, readable: Set<string>) {
  const hit = (t: string) => t.toLowerCase().includes(stem);
  const threads: Hit[] = [];
  const asks: AskHit[] = [];
  if (!stem) return { threads, asks };
  for (const t of r.list("thread", (x) => readable.has(x.s) && !x.gone && !x.del)) {
    const body = plain(t.sum);
    if (!hit(`${t.t ?? ""} ${t.q} ${body}`)) continue;
    const src = [body, t.q].find((x) => x && hit(x));
    threads.push({
      id: t.id,
      s: t.s,
      u: t.u,
      q: t.q,
      ex: !src || src === t.q ? (body ? excerpt(body, "\u0000") : "") : excerpt(src, stem),
      at: t.createdAt,
      n: r.get("counts", t.id)?.r ?? 0,
      k: t.k,
    });
  }
  for (const f of r.list("followup", (x) => readable.has(x.s) && !x.del)) {
    const a = plain(f.a);
    if (!hit(`${f.q} ${a}`)) continue;
    const t = r.get("thread", f.th);
    if (!t) continue;
    let level = 1;
    for (let p = f.par; p; p = r.get("followup", p)?.par ?? null) level++;
    asks.push({
      th: f.th,
      node: f.id,
      s: f.s,
      u: f.u,
      q: f.q,
      ex: a ? excerpt(a, hit(a) ? stem : "\u0000") : "",
      at: f.createdAt,
      level,
      title: t.t ?? t.q,
    });
  }
  threads.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { threads, asks };
}

export function SearchPage({ q: q0, scope }: { q: string; scope: string | undefined }) {
  const w = useWorld();
  const now = useNow();
  const navigate = useNavigate();
  const [q, setQ] = useState(q0);
  const [all, setAll] = useState<string | null>(null);
  // a new address (Back, a link) shows its query
  const [shownFor, setShownFor] = useState(q0);
  if (shownFor !== q0) {
    setShownFor(q0);
    setQ(q0);
  }
  const scoped = scope ? w.spaces.find((s) => s.name === scope) : undefined;
  const readable = useMemo(
    () =>
      new Set(
        w.spaces.filter((s) => canRead(w, s) && (!scoped || s.id === scoped.id)).map((s) => s.id),
      ),
    [w, scoped],
  );
  const stem = stemOf(q0);
  const key = [...readable].join(",");
  // search reads what this tab holds: open the logs of the spaces it searches
  const session = w.session;
  useEffect(() => {
    if (stem) for (const id of readable) void session?.showSpace(id);
  }, [stem, readable, session]);
  const res = useRecords((r) => search(r, stem, readable), [stem, key]) ?? {
    threads: [],
    asks: [],
  };
  const spaces = scoped
    ? []
    : w.spaces.filter(
        (s) =>
          s.vis !== "unlisted" &&
          stem &&
          `${s.name} ${s.title} ${s.desc}`.toLowerCase().includes(stem),
      );
  const ph = scoped
    ? `Search in ${spaceName(scoped)}`
    : "Search threads, spaces, pages and sources";
  const open = (th: string, s: string) => {
    const sp = w.byId.get(s);
    if (sp)
      void navigate({
        to: "/s/$space/t/$thread",
        params: { space: sp.name, thread: th },
        state: { from: { label: "Search", to: `/search?q=${encodeURIComponent(q0)}` } } as never,
      });
  };
  const tag = (s: Space | undefined) =>
    s ? (
      <>
        <button
          className="row-sp"
          type="button"
          onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
        >
          <SpaceTag s={s} />
        </button>
        <span aria-hidden="true">·</span>
      </>
    ) : null;
  const shown = <T,>(k: string, list: T[]) => (all === k ? list : list.slice(0, CAP));
  const showAll = (k: string, n: number) =>
    n > CAP && all !== k ? (
      <button className="tlink nv-all" type="button" onClick={() => setAll(k)}>
        Show all {n}
      </button>
    ) : null;
  return (
    <Page place={{ kind: "search" }}>
      <div className="home-wide sub-page br-page cs-search">
        <BackRow />
        <div className="sub-top">
          <h2>Search</h2>
        </div>
        <label className="search cs-sq">
          <Svg src={I.search} />
          <input
            id="cs-q"
            type="search"
            placeholder={ph}
            aria-label={ph}
            autoComplete="off"
            ref={(el) => {
              if (el && !q0 && !el.dataset["f"]) {
                el.dataset["f"] = "1";
                el.focus();
              }
            }}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                void navigate({
                  to: "/search",
                  search: { q: q.trim(), ...(scope ? { in: scope } : {}) },
                  replace: true,
                });
            }}
          />
        </label>
        {scoped ? (
          <div className="nv-scope">
            <span>In {spaceName(scoped)}</span>
            <button
              className="iconbtn"
              type="button"
              aria-label="Search all spaces"
              title="Search all spaces"
              onClick={() => void navigate({ to: "/search", search: { q: q0 } })}
            >
              <Svg src={I.close} />
            </button>
          </div>
        ) : null}
        {!stem ? (
          <p className="muted nv-sprompt">
            Type a word or phrase to search the threads, {scoped ? "" : "spaces, "}pages and sources
            you can read{scoped ? ` in ${spaceName(scoped)}` : ""}.
          </p>
        ) : (
          <div className="sr-two">
            <div>
              <section className="sr-sec">
                <h3 className="br-h">
                  Threads <span className="num">{res.threads.length}</span>
                </h3>
                <div className="sr-list">
                  {res.threads.length ? (
                    shown("threads", res.threads).map((h) => (
                      <article className="sr-row" key={h.id}>
                        <a
                          className="sr-t row-link"
                          href={`/s/${w.byId.get(h.s)?.name ?? ""}/t/${h.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            open(h.id, h.s);
                          }}
                        >
                          {highlight(h.q, stem)}
                        </a>
                        {h.ex ? <p className="sr-ex">{highlight(h.ex, stem)}</p> : null}
                        <div className="sr-meta">
                          {tag(w.byId.get(h.s))}
                          <Author u={h.u} />
                          <span>{ago(h.at, now)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="num">
                            {h.n}{" "}
                            {h.k === "ask"
                              ? h.n === 1
                                ? "follow-up"
                                : "follow-ups"
                              : h.n === 1
                                ? "reply"
                                : "replies"}
                          </span>
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="muted sr-none">No threads you can read match this search.</p>
                  )}
                </div>
                {showAll("threads", res.threads.length)}
              </section>
              {res.asks.length ? (
                <section className="sr-sec">
                  <h3 className="br-h">
                    Asks inside threads <span className="num">{res.asks.length}</span>
                  </h3>
                  <div className="sr-list">
                    {shown("asks", res.asks).map((h) => (
                      <article className="sr-row" key={h.node}>
                        <a
                          className="sr-t row-link"
                          href={`/s/${w.byId.get(h.s)?.name ?? ""}/t/${h.th}`}
                          onClick={(e) => {
                            e.preventDefault();
                            open(h.th, h.s);
                          }}
                        >
                          {highlight(h.q, stem)}
                        </a>
                        {h.ex ? <p className="sr-ex">{highlight(h.ex, stem)}</p> : null}
                        <div className="sr-meta">
                          {tag(w.byId.get(h.s))}
                          <Author u={h.u} />
                          <span>{ago(h.at, now)}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            Level {h.level} in {h.title}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                  {showAll("asks", res.asks.length)}
                </section>
              ) : null}
            </div>
            <aside className="sr-side">
              {scoped ? (
                <>
                  <h3 className="br-h">Space</h3>
                  <div className="sr-sp">
                    <SpaceGlyph s={scoped} />
                    <div className="br-nm">
                      <span className="cs-nmrow">
                        <button
                          className="dg-name"
                          type="button"
                          onClick={() =>
                            void navigate({ to: "/s/$space", params: { space: scoped.name } })
                          }
                        >
                          {spaceName(scoped)}
                        </button>
                        <Seal s={scoped} size="sm" />
                      </span>
                      <small className="num">{fmt(scoped.members)} members</small>
                    </div>
                  </div>
                  <button
                    className="tlink nv-all"
                    type="button"
                    onClick={() => void navigate({ to: "/search", search: { q: q0 } })}
                  >
                    Search all spaces
                  </button>
                </>
              ) : (
                <>
                  <h3 className="br-h">
                    Spaces <span className="num">{spaces.length}</span>
                  </h3>
                  {spaces.length ? (
                    spaces.map((s) => (
                      <div className="sr-sp" key={s.id}>
                        <SpaceGlyph s={s} />
                        <div className="br-nm">
                          <span className="cs-nmrow">
                            <button
                              className="dg-name"
                              type="button"
                              onClick={() =>
                                void navigate({ to: "/s/$space", params: { space: s.name } })
                              }
                            >
                              {spaceName(s)}
                            </button>
                            <Seal s={s} size="sm" />
                          </span>
                          <small className="num">{fmt(s.members)} members</small>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted sr-none">No spaces match.</p>
                  )}
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </Page>
  );
}
