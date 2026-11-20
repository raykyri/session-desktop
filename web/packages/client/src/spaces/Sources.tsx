// Sources (phase 2b, slice 3): a source's reader page (`/source/<id>`, the
// mockup's mi-page): what Session read of it, block by block, with Ask about
// a passage, the asks about it, its details, Save, Copy link and the More
// menu (Report this source; for the space's staff, Remove from the space);
// and Manage › Sources: the review queue, reported sources and who can add
// sources.

import type { SpaceSourceRec } from "@session/mutators";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { agoText, ago, dayOf, spaceName } from "../data/format.js";
import { isStaff, type Space } from "../data/spaces.js";
import { useNow, useRecords, useSession } from "../sync/react.js";

import { Modal, NotFound, Page } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Avatar, Author } from "./atoms.js";
import { cx } from "./cx.js";
import { I, MII, QTI, SFI } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { refusalToast, toast, useQuickWrite, useWrite } from "./writes.js";

const DS_WHY: [string, string][] = [
  ["spam", "Spam or advertising"],
  ["topic", "Not about this space"],
  ["broken", "Broken link or wrong reader copy"],
  ["other", "Something else"],
];

const minutesOf = (m: SpaceSourceRec["meta"]) => {
  const words = m.body
    .map((b) => b.p ?? b.h ?? "")
    .join(" ")
    .split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
};

/** The spaces' copies of a source the reader may read: the first gives its meta. */
function useSource(id: string) {
  return (
    useRecords(
      (r) => ({
        copies: r.list("spacesrc", (x) => x.src === id && !x.rm),
        saved: r.me ? r.get("srcsave", `${r.me}:${id}`) !== undefined : false,
        asks: r
          .list("thread", (t) => t.about?.it === id || (t.about?.its ?? []).includes(id))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        catalog: r.get("source", id) ?? null,
      }),
      [id],
    ) ?? { copies: [], saved: false, asks: [], catalog: null }
  );
}

function ReportDialog({
  s,
  id,
  title,
  onClose,
}: {
  s: Space;
  id: string;
  title: string;
  onClose: () => void;
}) {
  const write = useWrite();
  const [why, setWhy] = useState("topic");
  const send = async () => {
    onClose();
    const o = await write("sourceReports.create", { space: s.id, source: id, why });
    if (o.ok)
      toast(
        `Report sent to the moderators of ${spaceName(s)}. You get a notification when they resolve it.`,
      );
  };
  return (
    <Modal
      title="Report this source"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={() => void send()}>
            Send report
          </button>
        </>
      }
    >
      <div className="mi-mini">
        <span className="mi-ic mi-k-article">
          <Svg src={MII.article} />
        </span>
        <span className="mi-mini-tx">
          <b>{title}</b>
          <span>{spaceName(s)}</span>
        </span>
      </div>
      <div className="cs-radios" role="radiogroup" aria-label="Reason">
        {DS_WHY.map(([k, l]) => (
          // the label's text is in its <b> (the mockup's cs-rad), deeper than the rule looks
          // eslint-disable-next-line jsx-a11y/label-has-associated-control
          <label className="cs-rad" key={k}>
            <input
              type="radio"
              name="ds-why"
              value={k}
              checked={why === k}
              onChange={() => setWhy(k)}
            />
            <span>
              <b>{l}</b>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function AskBox({
  s,
  id,
  b,
  onDone,
}: {
  s: Space;
  id: string;
  b: number | null;
  onDone: () => void;
}) {
  const write = useWrite();
  const session = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const ask = async () => {
    if (!q.trim()) return;
    const tid = session?.newId() ?? "";
    const o = await write("threads.create", {
      id: tid,
      space: s.id,
      kind: "ask",
      q: q.trim(),
      pay: "session",
      about: b === null ? { it: id } : { it: id, b },
    });
    if (o.ok) {
      onDone();
      void navigate({ to: "/s/$space/t/$thread", params: { space: s.name, thread: tid } });
    }
  };
  return (
    <div className="composer open c2 c2v-bar mi-askc">
      <textarea
        id="mi-ask"
        rows={2}
        placeholder={b === null ? "Ask about this source" : "Ask about this passage"}
        aria-label={b === null ? "Ask about this source" : "Ask about this passage"}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="c2-bar">
        <span className="c2-note">In {spaceName(s)} · uses your included tokens</span>
        <span className="grow" />
        <span className="c2-end">
          <button className="btn" type="button" onClick={onDone}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!q.trim()}
            onClick={() => void ask()}
          >
            Ask
          </button>
        </span>
      </div>
    </div>
  );
}

export function SourcePage({ id }: { id: string }) {
  const w = useWorld();
  const now = useNow();
  const navigate = useNavigate();
  const quick = useQuickWrite();
  const write = useWrite();
  const { copies, saved, asks, catalog } = useSource(id);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [askAt, setAskAt] = useState<number | null | undefined>(undefined);
  useOverlay(menu, () => setMenu(false));
  const copy = copies[0];
  const m = copy?.meta ?? catalog?.meta;
  const s = copy ? w.byId.get(copy.sp) : undefined;
  if (!m) {
    if (!w.loaded) return <Page place={{ kind: "other" }}>{null}</Page>;
    return (
      <Page place={{ kind: "other" }}>
        <NotFound />
      </Page>
    );
  }
  const title = m.t ?? m.body[0]?.p?.slice(0, 80) ?? m.au;
  const staff = s ? isStaff(w.roles[s.id]) : false;
  return (
    <Page place={s ? { kind: "space", id: s.id } : { kind: "other" }}>
      <div className="mi-page">
        <div className="mi-bar">
          {s ? (
            <button
              className="th-back"
              type="button"
              onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
            >
              <Svg src={I.chev} className="bk" />
              {spaceName(s)}
            </button>
          ) : (
            <span />
          )}
          <div className="mi-acts">
            {m.url ? (
              <a
                className="btn sm mi-orig"
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Read on ${m.pl}`}
              >
                <Svg src={MII.ext} />
              </a>
            ) : null}
            {w.me ? (
              <button
                className="btn sm"
                type="button"
                aria-pressed={saved}
                onClick={() => quick("saved.set", { kind: "source", id, on: !saved })}
              >
                <Svg src={I.mark} />
                {saved ? "Saved" : "Save"}
              </button>
            ) : null}
            <button
              className="btn sm d-only"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(location.href).catch(() => undefined);
                toast("Link copied.");
              }}
            >
              Copy link
            </button>
            {s && w.me ? (
              <span className="sf-imw ds-mw">
                <button
                  className="btn sm ds-more"
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={menu}
                  aria-label="More actions"
                  title="More"
                  onClick={() => setMenu((x) => !x)}
                >
                  <Svg src={SFI.more} />
                </button>
                {menu ? (
                  <>
                    <Scrim onClose={() => setMenu(false)} />
                    <div className="pop cs-pop sf-ipop" role="menu">
                      <button
                        className="um-item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(false);
                          setReport(true);
                        }}
                      >
                        <Svg src={SFI.flag} />
                        <span>Report this source</span>
                      </button>
                      {staff ? (
                        <button
                          className="um-item cx-danger-i"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(false);
                            void write("spaceSources.review", {
                              space: s.id,
                              source: id,
                              decision: "remove",
                            }).then((o) => {
                              if (o.ok) toast(`Removed from ${spaceName(s)}.`);
                            });
                          }}
                        >
                          <Svg src={I.close} />
                          <span>Remove from {spaceName(s)}</span>
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mi-grid">
          <article className="mi-main">
            <header className="mi-head">
              <div className="mi-src">
                <span className="mi-ic mi-k-article" title={m.pl}>
                  <Svg src={MII.article} />
                </span>
                <span>{[m.pl, m.h].filter(Boolean).join(" · ")}</span>
                {copy ? (
                  <span className="faint mi-via">
                    Added by {copy.by} {agoText(copy.createdAt, now)}
                  </span>
                ) : null}
              </div>
              <h1 className="mi-title">{title}</h1>
              <div className="mi-by">
                <Avatar u={m.au} className="sm" />
                <span>{m.au}</span>
                <span className="faint mi-via">{m.len || `${minutesOf(m)} min read`}</span>
              </div>
            </header>
            <div className="mi-reader mi-r-article askable">
              {m.body.map((b, k) =>
                b.h ? (
                  <h3 className="mi-h" key={k}>
                    {b.h}
                  </h3>
                ) : (
                  <div
                    className={cx("mi-b", asks.some((t) => t.about?.b === k) && "has-asks")}
                    id={`mib-${k}`}
                    key={k}
                  >
                    <div className="mi-bt">
                      {b.q ? (
                        <blockquote>
                          <p>{b.q.t}</p>
                          <small>
                            {b.q.au} {b.q.h}
                          </small>
                        </blockquote>
                      ) : (
                        <p>{b.p ?? b.sp ?? ""}</p>
                      )}
                    </div>
                    {s && w.me ? (
                      <button
                        className="mi-bask"
                        type="button"
                        aria-label={`Ask about paragraph ${k + 1}`}
                        title="Ask about this passage"
                        onClick={() => setAskAt(k)}
                      >
                        <Svg src={QTI.ask} />
                      </button>
                    ) : null}
                    {askAt === k && s ? (
                      <AskBox s={s} id={id} b={k} onDone={() => setAskAt(undefined)} />
                    ) : null}
                  </div>
                ),
              )}
            </div>
            {s && w.me ? (
              <div className="mi-askbox">
                {askAt === null ? (
                  <AskBox s={s} id={id} b={null} onDone={() => setAskAt(undefined)} />
                ) : (
                  <button
                    className="composer c2-closed"
                    type="button"
                    onClick={() => setAskAt(null)}
                  >
                    <span className="ph">Ask about this source…</span>
                  </button>
                )}
              </div>
            ) : null}
            <section className="mi-asks" id="mi-asks">
              <h3>
                Asks about this source <span className="faint num">{asks.length}</span>
              </h3>
              <div className="mi-acs">
                {asks.map((t) => {
                  const sp = w.byId.get(t.s);
                  return (
                    <article className="mi-ac" key={t.id}>
                      <div className="meta">
                        <Avatar u={t.u} className="sm" />
                        <Author u={t.u} />
                        <span>{ago(t.createdAt, now)}</span>
                        {typeof t.about?.b === "number" ? (
                          <span className="mi-scope">¶{t.about.b + 1}</span>
                        ) : null}
                      </div>
                      <button
                        className="mi-ac-q row-link"
                        type="button"
                        onClick={() =>
                          sp &&
                          void navigate({
                            to: "/s/$space/t/$thread",
                            params: { space: sp.name, thread: t.id },
                          })
                        }
                      >
                        {t.q}
                      </button>
                      {t.sum ? (
                        <div className="mi-ac-a">
                          <span className="agent">
                            <Svg src={I.agent} />
                          </span>
                          <p>{t.sum.split("\n")[0]}</p>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {asks.length ? null : (
                  <p className="muted cs-small">No asks about this source yet.</p>
                )}
              </div>
            </section>
          </article>
          <aside className="mi-aside">
            <div className="rf-card">
              <h3>Details</h3>
              <div className="th-facts mi-facts">
                <div>
                  <span>Source</span>
                  <b>{[m.pl, m.h].filter(Boolean).join(" · ")}</b>
                </div>
                <div>
                  <span>Author</span>
                  <b>{m.au}</b>
                </div>
                {copy ? (
                  <div>
                    <span>Added</span>
                    <b>{dayOf(copy.createdAt, now)}</b>
                  </div>
                ) : null}
                <div>
                  <span>Length</span>
                  <b>{m.len || `${minutesOf(m)} min read`}</b>
                </div>
                <div>
                  <span>Reading it in full</span>
                  <b className="num">{m.tok ? `${Math.round(m.tok / 1000)}k tokens` : "—"}</b>
                </div>
              </div>
            </div>
            {copies.length > 1 ? (
              <div className="rf-card mi-also">
                <h3>Also in</h3>
                {copies.slice(1).map((c) => {
                  const sp = w.byId.get(c.sp);
                  return sp ? (
                    <div className="mi-sprow" key={c.sp}>
                      <span className="cs-nmrow">{spaceName(sp)}</span>
                    </div>
                  ) : null;
                })}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
      {report && s ? (
        <ReportDialog s={s} id={id} title={title} onClose={() => setReport(false)} />
      ) : null}
    </Page>
  );
}

/** Manage › Sources: waiting for review, reported, and who can add. */
export function SourcesManage({ s }: { s: Space }) {
  const now = useNow();
  const write = useWrite();
  const navigate = useNavigate();
  const data = useRecords(
    (r) => ({
      pending: r.list("spacesrc", (x) => x.sp === s.id && x.rv && !x.rm),
      reps: r.list("srcrep", (x) => x.sp === s.id),
      all: r.list("spacesrc", (x) => x.sp === s.id),
      policy: r.get("space", s.id)?.srcPolicy ?? "members",
    }),
    [s.id],
  ) ?? { pending: [], reps: [], all: [], policy: "members" as const };
  const titleOf = (src: string) => {
    const m = data.all.find((x) => x.src === src)?.meta;
    return m?.t ?? m?.body[0]?.p?.slice(0, 80) ?? src;
  };
  const review = async (src: string, decision: "approve" | "reject" | "remove" | "keep") => {
    const o = await write(
      "spaceSources.review",
      { space: s.id, source: src, decision },
      { quiet: true },
    );
    if (o.ok)
      toast(
        decision === "approve"
          ? "Approved. Members see it in Sources."
          : decision === "keep"
            ? "Kept. The reports were resolved."
            : `Removed from ${spaceName(s)}.`,
      );
    else if (o.error) refusalToast(o.error);
  };
  const reported = [...new Set(data.reps.map((r) => r.src))];
  const POL: [string, string, string][] = [
    ["members", "Anyone who can post", "Sources appear in the list when they are added."],
    [
      "review",
      "Anyone who can post, after review",
      "A moderator approves each source before others see it.",
    ],
    ["mods", "Moderators", "Others can still ask about a link they paste into the composer."],
  ];
  return (
    <div className="cs-set st-side">
      <section className="st-sec">
        <div className="st-head">
          <h3>Waiting for review</h3>
        </div>
        <div className="st-body">
          <div className="ds-mlist">
            {data.pending.map((x) => (
              <div className="ds-mrow" key={x.src}>
                <span className="mi-ic mi-k-article sm">
                  <Svg src={MII.article} />
                </span>
                <div className="ds-mrow-t">
                  <button
                    className="tlink"
                    type="button"
                    onClick={() => void navigate({ to: "/source/$id", params: { id: x.src } })}
                  >
                    <b>{titleOf(x.src)}</b>
                  </button>
                  <small>
                    Added by {x.by} {agoText(x.createdAt, now)}
                    {x.note ? ` · ${x.note}` : ""}
                  </small>
                </div>
                <span className="ds-mrow-a">
                  <button
                    className="btn sm"
                    type="button"
                    onClick={() => void review(x.src, "reject")}
                  >
                    Remove
                  </button>
                  <button
                    className="btn sm primary"
                    type="button"
                    onClick={() => void review(x.src, "approve")}
                  >
                    Approve
                  </button>
                </span>
              </div>
            ))}
            {data.pending.length ? null : (
              <p className="muted cs-small">No sources waiting for review.</p>
            )}
          </div>
        </div>
      </section>
      <section className="st-sec">
        <div className="st-head">
          <h3>Reported</h3>
        </div>
        <div className="st-body">
          <div className="ds-mlist">
            {reported.map((src) => {
              const rs = data.reps.filter((r) => r.src === src);
              return (
                <div className="ds-mrow" key={src}>
                  <span className="mi-ic mi-k-article sm">
                    <Svg src={SFI.flag} />
                  </span>
                  <div className="ds-mrow-t">
                    <b>{titleOf(src)}</b>
                    <small>
                      {rs
                        .map((r) => `${DS_WHY.find((w) => w[0] === r.why)?.[1] ?? r.why} (${r.by})`)
                        .join(" · ")}
                    </small>
                  </div>
                  <span className="ds-mrow-a">
                    <button
                      className="btn sm"
                      type="button"
                      onClick={() => void review(src, "keep")}
                    >
                      Keep
                    </button>
                    <button
                      className="btn sm"
                      type="button"
                      onClick={() => void review(src, "remove")}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              );
            })}
            {reported.length ? null : <p className="muted cs-small">No reported sources.</p>}
          </div>
        </div>
      </section>
      <section className="st-sec">
        <div className="st-head">
          <h3>Who can add sources</h3>
        </div>
        <div className="st-body">
          <div className="cs-radios">
            {POL.map(([k, l, d]) => (
              // the label's text is in its <b> (the mockup's cs-rad), deeper than the rule looks
              // eslint-disable-next-line jsx-a11y/label-has-associated-control
              <label className="cs-rad" key={k}>
                <input
                  type="radio"
                  name="ds-pol"
                  value={k}
                  checked={data.policy === k}
                  onChange={() =>
                    void write("spaceSources.setPolicy", { space: s.id, policy: k }).then((o) => {
                      if (o.ok) toast("Saved.");
                    })
                  }
                />
                <span>
                  <b>{l}</b>
                  <small>{d}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      </section>
      <section className="st-sec">
        <div className="st-head">
          <h3>Reader copies</h3>
        </div>
        <div className="st-body">
          <ul className="mi-plain">
            <li>
              Session keeps one reader copy of each source, shared by the spaces that have it.
            </li>
            <li>Paid posts: only the free part is kept.</li>
            <li>
              When the author edits a source, both versions are kept and answers that quote the old
              text are marked.
            </li>
            <li>
              When the author deletes a source, its copy is removed and quotes are replaced with a
              note.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
