// The FAQ landing of a space with topics (the mockup's `faqLanding`): the
// topics, a box that searches the space's answers as the person types, a card
// per topic with its questions, and the recent threads. A topic opens its
// list; Latest is the plain feed.

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ago, spaceName } from "../data/format.js";
import type { Row, Space } from "../data/spaces.js";
import { useNow } from "../sync/react.js";

import { FeedRow } from "./Feed.js";
import { highlight, stemOf } from "./SearchPage.js";
import { Author } from "./atoms.js";

const CARD = 3;
const RECENT = 4;

export const topicSlug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A space's topics with their threads; threads without one are "Other". */
export function topicsOf(s: Space, rows: Row[]) {
  const asks = rows.filter((r) => r.k === "ask" && !r.del && !r.mod);
  const list = s.topics.map(([id, title]) => ({
    id,
    title,
    rows: asks.filter((r) => r.topic === id),
  }));
  const known = new Set(s.topics.map(([id]) => id));
  const other = asks.filter((r) => !r.topic || !known.has(r.topic));
  if (other.length) list.push({ id: "other", title: "Other", rows: other });
  return { all: asks, list };
}

export function FaqLanding({ s, rows, topic }: { s: Space; rows: Row[]; topic: string | null }) {
  const navigate = useNavigate();
  const now = useNow();
  const [q, setQ] = useState("");
  const { all, list } = topicsOf(s, rows);
  const cur = topic ? list.find((t) => topicSlug(t.title) === topic) : undefined;
  const go = (t: { title: string } | null) =>
    void navigate(
      t
        ? { to: "/s/$space/topics/$topic", params: { space: s.name, topic: topicSlug(t.title) } }
        : { to: "/s/$space", params: { space: s.name } },
    );
  const open = (id: string) =>
    void navigate({
      to: "/s/$space/t/$thread",
      params: { space: s.name, thread: id },
      state: { from: { label: spaceName(s), to: `/s/${s.name}`, space: s.id } } as never,
    });
  const stem = stemOf(q);
  const matches = stem
    ? all.filter((r) => `${r.q} ${r.summary ?? ""}`.toLowerCase().includes(stem)).slice(0, 5)
    : [];
  const recent = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, RECENT);
  return (
    <div className="rf-idx sf-land">
      <nav className="rf-toc" aria-label="Topics">
        <div className="eyebrow">Topics</div>
        <button type="button" className="rf-toc-i" aria-current={!cur} onClick={() => go(null)}>
          All answers <span className="num">{all.length}</span>
        </button>
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            className="rf-toc-i"
            aria-current={cur?.id === t.id}
            onClick={() => go(t)}
          >
            {t.title} <span className="num">{t.rows.length}</span>
          </button>
        ))}
      </nav>
      <div className="rf-idx-main">
        <div className="rf-sbox">
          <input
            id="faq-q"
            type="search"
            autoComplete="off"
            placeholder="Search or ask a question"
            aria-label={`Search answers in ${spaceName(s)} or ask a question`}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
          <button
            className="btn primary"
            type="button"
            disabled={!q.trim()}
            aria-disabled={!q.trim()}
          >
            Ask
          </button>
        </div>
        <div id="faq-res" className="rf-results">
          {stem ? (
            matches.length ? (
              <div className="rf-rows">
                {matches.map((r) => (
                  <article className="rf-row" key={r.id}>
                    <a
                      className="rf-row-q row-link"
                      href={`/s/${s.name}/t/${r.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        open(r.id);
                      }}
                    >
                      {highlight(r.q, stem)}
                    </a>
                    {r.summary ? <span className="rf-row-s">{r.summary}</span> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No answers match. Ask it as a new question.</p>
            )
          ) : null}
        </div>
        <div className="sf-tchips" role="navigation" aria-label="Topics">
          <button
            type="button"
            className="mchip sf-tchip"
            aria-current={!cur}
            onClick={() => go(null)}
          >
            All
          </button>
          {/* the mockup's faqChips: the topics that have answers, then Other */}
          {list
            .filter((t) => t.rows.length > 0)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                className="mchip sf-tchip"
                aria-current={cur?.id === t.id}
                onClick={() => go(t)}
              >
                {t.title}
              </button>
            ))}
        </div>
        {cur ? (
          <div className="rf-faq">
            <div className="rf-faq-h">
              <button className="th-back" type="button" onClick={() => go(null)}>
                All topics
              </button>
              <h4>
                {cur.title} <span className="faint num">{cur.rows.length}</span>
              </h4>
            </div>
            <div className="rf-rows">
              {cur.rows.map((r) => (
                <article className="rf-row" key={r.id}>
                  <a
                    className="rf-row-q row-link"
                    href={`/s/${s.name}/t/${r.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      open(r.id);
                    }}
                  >
                    {r.q}
                  </a>
                  {r.summary ? <span className="rf-row-s">{r.summary}</span> : null}
                  <span className="rf-row-m">
                    <Author u={r.u} />
                    <span>{ago(r.createdAt, now)}</span>
                    <span className="num">
                      {r.n} {r.n === 1 ? "follow-up" : "follow-ups"}
                    </span>
                  </span>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="rf-topics">
              {list.map((t) => (
                <section className="rf-tcard" key={t.id}>
                  <button type="button" className="rf-tcard-h" onClick={() => go(t)}>
                    <b>{t.title}</b>
                    <span className="faint num">{t.rows.length}</span>
                  </button>
                  <ul>
                    {t.rows.slice(0, CARD).map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => open(r.id)}>
                          {r.q}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <section className="sf-recent">
              <div className="sf-sech">
                <h3>Recent</h3>
                <button
                  className="tlink"
                  type="button"
                  onClick={() =>
                    void navigate({ to: "/s/$space/latest", params: { space: s.name } })
                  }
                >
                  See all threads
                </button>
              </div>
              <div className="rows rows-plain" role="list">
                {recent.map((r) => (
                  <FeedRow
                    key={r.id}
                    p={r}
                    space={s}
                    tag={false}
                    from={{ label: spaceName(s), to: `/s/${s.name}`, space: s.id }}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
