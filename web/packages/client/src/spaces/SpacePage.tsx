// A space's page (the mockup's `layoutSpace`, B: banner and flush sidebar):
// the banner, the Threads tab with the composer, search in the space and the
// feed, and the sidebar with its Sources and About tabs.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ago, dayOf, fmt, isClosed, isVerified, spaceName } from "../data/format.js";
import { isStaff, threadRows, type Space } from "../data/spaces.js";
import { useNow, useRecords } from "../sync/react.js";

import { Author, Avatar, Seal, SpaceGlyph } from "./atoms.js";
import { Composer } from "./Composer.js";
import { FaqLanding, topicsOf, topicSlug } from "./FaqLanding.js";
import { Feed, SortControl, useFeedState } from "./Feed.js";
import { CI, I, MI, MII, SVG } from "./icons.js";
import { NotFound, Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { canRead, useWorld } from "./world.js";

const policyLabel = (s: Space) => (s.policy === "invite" ? "Invite only" : "Join by request");
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", mod: "Moderator" };
const ROLE_TITLE: Record<string, string> = {
  owner: "Owner: settings and moderators; archives or deletes the space",
  admin: "Admin: settings, moderators and members",
  mod: "Moderator: requests, reports and members",
};

function Banner({ s, compact }: { s: Space; compact: boolean }) {
  const w = useWorld();
  const role = w.roles[s.id];
  const review =
    useRecords((r) => (isStaff(role) ? r.list("request", (q) => q.sp === s.id && q.st === "open").length + r.list("report", (q) => q.sp === s.id && q.st === "open").length : 0), [s.id, role]) ?? 0;
  const closed = isClosed(s);
  return (
    <div className={`banner${compact ? " sf-compact" : ""} has-tabs`} style={{ ["--sp" as string]: `var(--av${s.av || 1})` }}>
      <SpaceGlyph s={s} className={compact ? "lg" : "xl"} />
      <div style={{ minWidth: 0 }}>
        <h2>
          {spaceName(s)}
          <Seal s={s} size="lg" />
        </h2>
        <p className="sf-desc">{s.desc}</p>
        {closed || isVerified(s) || s.archived ? (
          <div className="cs-brow">
            {closed ? (
              <>
                <span className="cs-vis">
                  <Svg src={s.vis === "unlisted" ? CI.eyeOff : SVG.LOCK} />
                  {s.vis === "unlisted" ? "Closed, unlisted" : "Closed"}
                </span>
                <span className="num">{fmt(s.members)} members</span>
                <span>{policyLabel(s)}</span>
              </>
            ) : null}
            {isVerified(s) ? (
              <span className="sf-ver">
                <Svg src={SVG.SEAL} />
                Verified: {s.dom?.domain}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="banner-acts">
        {isStaff(role) ? (
          <button className="btn cs-b cs-mgb" type="button" aria-label={`Manage ${spaceName(s)}`} title="Manage">
            <Svg src={MI.cog} />
            <span className="d-only">Manage</span>
            {review ? (
              <span className="cs-n num" aria-label={`${review} requests and reports to review`}>
                {review}
              </span>
            ) : null}
          </button>
        ) : null}
        {role !== undefined ? (
          closed ? (
            <div className="cs-mw">
              <button className="btn cs-b" type="button" aria-haspopup="true" aria-expanded="false">
                Joined
                <Svg src={I.chev} className="cs-cv" />
              </button>
            </div>
          ) : (
            <button className="btn" type="button">
              Joined
            </button>
          )
        ) : !closed ? (
          <button className="btn primary" type="button">
            Join
          </button>
        ) : null}
      </div>
    </div>
  );
}

type SideTab = "sources" | "wiki";

function SourcesTab({ s }: { s: Space }) {
  const now = useNow();
  const list =
    useRecords(
      (r) =>
        r
          .list("spacesrc", (x) => x.sp === s.id && !x.rm && !x.rv)
          .map((x) => ({ src: x.src, by: x.by, at: x.createdAt, meta: x.meta }))
          .sort((a, b) => (a.at < b.at ? 1 : -1)),
      [s.id],
    ) ?? [];
  return (
    <div className="dbody ds-pane" role="tabpanel">
      <div className="ds-drop">
        <div className="ds-in">
          <Svg src={MII.link} />
          <input
            id="ds-url"
            type="url"
            placeholder="Paste a link or drop a file"
            aria-label={`Add a source to ${spaceName(s)}: paste a link`}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="mi-units mi-lay-rows mi-sty-social ds-units ds-sunits" role="list">
        {list.length === 0 ? <p className="muted cs-small">No sources yet.</p> : null}
        {list.map((x) => {
          const m = x.meta;
          const host = m.url.replace(/^https?:\/\//, "").split("/")[0] ?? m.url;
          return (
            <article key={x.src} className="mi-u mi-u2" tabIndex={0}>
              <div className="mi-p">
                {m.t ? (
                  <span className="mi-ic mi-k-article">
                    <Svg src={MII.article} />
                  </span>
                ) : (
                  <Avatar u={m.h || m.au} />
                )}
                <div className="mi-p-b">
                  <span className="mi-p-h">
                    <b>{m.au}</b>
                    {!m.t && m.h ? <span className="faint">{m.h}</span> : null}
                    <span className="faint">· {ago(x.at, now)}</span>
                  </span>
                  {m.t ? (
                    <div className="mi-lp">
                      <span className="mi-lc-d">{host}</span>
                      <b className="mi-u-t">{m.t}</b>
                      <span className="mi-u-x">{m.desc}</span>
                    </div>
                  ) : (
                    <p className="mi-p-t">{m.body[0]?.p ?? m.sum}</p>
                  )}
                </div>
              </div>
              <span className="ds-ux" />
            </article>
          );
        })}
      </div>
    </div>
  );
}

function AboutTab({ s }: { s: Space }) {
  const now = useNow();
  const w = useWorld();
  const role = w.roles[s.id];
  const pages = useRecords((r) => r.get("pages", s.id)?.list ?? [], [s.id]) ?? [];
  const skills =
    useRecords(
      (r) => {
        const order = r.get("skills", s.id)?.order ?? [];
        return order.flatMap((id) => {
          const k = r.get("skill", id);
          return k ? [{ id: k.id, name: k.name, prompt: k.prompt }] : [];
        });
      },
      [s.id],
    ) ?? [];
  const owner = s.mods.find(([, r]) => r === "owner")?.[0];
  const closed = isClosed(s);
  return (
    <div className="dbody" role="tabpanel">
      <div className="note-card">
        <p className="sf-ab-d">{s.desc}</p>
      </div>
      {s.rules.length ? (
        <div className="note-card">
          <h3>Rules</h3>
          <ol>
            {s.rules.map((r, k) => (
              <li key={k}>{r}</li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="note-card ab-pages">
        <div className="ab-ch">
          <h3>Pages</h3>
        </div>
        {pages.length ? (
          <ul className="links ab-pgl">
            {pages.map((p) => (
              <li key={p.id}>
                <button className="ab-pgr" type="button">
                  <Svg src={I.page} />
                  <span>{p.t}</span>
                  <small>{ago(p.at, now)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted cs-small abw-none">No pages yet.</p>
        )}
      </div>
      <div className="note-card skills">
        <div className="sk-head">
          <h3>Skills</h3>
          {skills.length ? <span className="edited">{skills.length}</span> : null}
        </div>
        {skills.length ? (
          <div className="sk-list">
            {skills.map((k) => (
              <button key={k.id} className="sk-row" type="button" title={k.prompt}>
                <span className="sk-ic">
                  <Svg src={I.agent} />
                </span>
                <span className="sk-tx">
                  <b>{k.name}</b>
                  <small>{k.prompt}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted cs-small abw-none">No skills yet.</p>
        )}
      </div>
      <div className="note-card">
        <h3>Details</h3>
        <div className="th-facts">
          <div>
            <span>Visibility</span>
            <b>{closed ? (s.vis === "unlisted" ? "Closed, unlisted" : "Closed") : "Open"}</b>
          </div>
          <div>
            <span>Joining</span>
            <b>{closed ? policyLabel(s) : "Anyone can join"}</b>
          </div>
          <div>
            <span>Members</span>
            <b>
              <span className="num">{s.members.toLocaleString("en-US")}</span>
            </b>
          </div>
          <div>
            <span>Created</span>
            <b>
              {dayOf(s.createdAt, now).split(" ")[0]} {new Date(s.createdAt).getUTCFullYear()}
              {owner ? (
                <>
                  {" "}
                  by <Author u={owner} />
                </>
              ) : null}
            </b>
          </div>
          {isVerified(s) ? (
            <div>
              <span>Domain</span>
              <b className="sf-vd">
                <Svg src={SVG.SEAL} />
                {s.dom?.domain}
              </b>
            </div>
          ) : null}
        </div>
      </div>
      <div className="note-card">
        <h3>Moderators</h3>
        <div className="mods">
          {s.mods.map(([h, r]) => (
            <div key={h}>
              <Avatar u={h} className="sm" />
              <Author u={h} />
              <small title={ROLE_TITLE[r]}>{ROLE_LABEL[r] ?? r}</small>
            </div>
          ))}
        </div>
      </div>
      {role === undefined ? null : null}
    </div>
  );
}

function Sidebar({ s }: { s: Space }) {
  // a space with the FAQ landing opens on About, the others on Sources
  const [tab, setTab] = useState<SideTab>(s.faq ? "wiki" : "sources");
  return (
    <aside className="drawer wk ds-side" aria-label="Sources and about">
      <div className="dh ds-tabs">
        <span role="tablist" className="ds-tabl">
          <button
            className="ds-stab"
            type="button"
            role="tab"
            aria-selected={tab === "sources"}
            onClick={() => setTab("sources")}
          >
            Sources
          </button>
          <button
            className="ds-stab"
            type="button"
            role="tab"
            aria-selected={tab === "wiki"}
            onClick={() => setTab("wiki")}
          >
            About
          </button>
        </span>
        <span className="grow" />
      </div>
      {tab === "sources" ? <SourcesTab s={s} /> : <AboutTab s={s} />}
    </aside>
  );
}

/** The topics column of the FAQ views. */
function FaqToc({ s, rows }: { s: Space; rows: Parameters<typeof topicsOf>[1] }) {
  const navigate = useNavigate();
  const { all, list } = topicsOf(s, rows);
  return (
    <nav className="rf-toc" aria-label="Topics">
      <div className="eyebrow">Topics</div>
      <button type="button" className="rf-toc-i" aria-current="false" onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}>
        All answers <span className="num">{all.length}</span>
      </button>
      {list.map((t) => (
        <button
          key={t.id}
          type="button"
          className="rf-toc-i"
          aria-current="false"
          onClick={() => void navigate({ to: "/s/$space/topics/$topic", params: { space: s.name, topic: topicSlug(t.title) } })}
        >
          {t.title} <span className="num">{t.rows.length}</span>
        </button>
      ))}
    </nav>
  );
}

function SpaceSearch({ s }: { s: Space }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <label className="search nv-spq">
      <Svg src={I.search} />
      <input
        id="nv-spq"
        type="search"
        placeholder={`Search in ${spaceName(s)}`}
        aria-label={`Search in ${spaceName(s)}`}
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim())
            void navigate({ to: "/search", search: { q: q.trim(), in: s.name } });
        }}
      />
    </label>
  );
}

/** A closed space the reader may not read: the gate (joining is the
 * second slice's). */
function Gate({ s }: { s: Space }) {
  return (
    <div className="body">
      <div className="ds-top">
        <Banner s={s} compact={false} />
      </div>
      <div className="mcol">
        <div className="main">
          <div className="cs-empty">
            <p>
              <b>Only members can read {spaceName(s)}</b>
            </p>
            <p className="muted">{policyLabel(s)}.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Which view of a space's Threads tab: the FAQ landing or a topic, or the
 * feed (Latest, on a space with the landing). */
export type SpaceView = { kind: "threads" } | { kind: "latest" } | { kind: "topic"; topic: string };

export function SpacePage({ name, view = { kind: "threads" } }: { name: string; view?: SpaceView }) {
  const w = useWorld();
  const f = useFeedState();
  const navigate = useNavigate();
  const s = useMemo(() => w.spaces.find((x) => x.name === name), [w.spaces, name]);
  const session = w.session;
  useEffect(() => {
    if (s) void session?.showSpace(s.id);
  }, [s, session]);
  const rows = useRecords((r) => (s ? threadRows(r, new Set([s.id])) : []), [s?.id]) ?? [];
  if (!s) {
    if (!w.loaded) return <Page place={{ kind: "other" }}>{null}</Page>;
    return (
      <Page place={{ kind: "other" }}>
        <NotFound space={name} />
      </Page>
    );
  }
  const feed = (
    <>
      <Composer space={s} />
      <div className="fbar fbar-k nv-fbar">
        <SpaceSearch s={s} />
        <SortControl f={f} />
      </div>
      <Feed
        rows={rows}
        f={f}
        spaces={w.byId}
        tag={false}
        page={20}
        from={{ label: spaceName(s), to: `/s/${s.name}`, space: s.id }}
      />
    </>
  );
  if (!canRead(w, s))
    return (
      <Page cls="" place={{ kind: "space", id: s.id }}>
        <Gate s={s} />
      </Page>
    );
  return (
    <Page cls="ds-hd" place={{ kind: "space", id: s.id }}>
      <div className="body">
        <div className="ds-top">
          <Banner s={s} compact={s.faq} />
        </div>
        <div className="mcol">
          <nav className="sp-tabs" aria-label={spaceName(s)}>
            <button type="button" className="sp-tab" aria-current="true">
              Threads
            </button>
          </nav>
          {s.faq && view.kind !== "latest" ? (
            <FaqLanding s={s} rows={rows} topic={view.kind === "topic" ? view.topic : null} />
          ) : s.faq ? (
            <div className="rf-idx sf-land sf-latest">
              <FaqToc s={s} rows={rows} />
              <div className="rf-idx-main">
                <button
                  className="th-back sf-vback"
                  type="button"
                  onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
                >
                  Topics
                </button>
                {feed}
              </div>
            </div>
          ) : (
            <div className="main">{feed}</div>
          )}
        </div>
        <Sidebar s={s} />
      </div>
    </Page>
  );
}
