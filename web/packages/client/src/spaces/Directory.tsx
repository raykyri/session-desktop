// Browse spaces (`/spaces/browse`, the mockup's layoutBrowse), Create a space
// (`/spaces/new`, spaces.create: an online call that answers with the
// space), and a person's profile (`/u/<handle>`: their threads in the spaces
// the reader reads, Mute and Block).

import type { SpaceRec } from "@session/mutators";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { ago, isClosed, spaceName } from "../data/format.js";
import { threadRows, type Space } from "../data/spaces.js";
import { useNow, useRecords, useSession } from "../sync/react.js";

import { JoinControl, JoinCta } from "./Membership.js";
import { Page } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Avatar, Glyph, Seal } from "./atoms.js";
import { CI, SFI, SVG } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { canRead, useWorld } from "./world.js";
import { refusalToast, toast, useWrite } from "./writes.js";

function Action({ s }: { s: Space }) {
  return isClosed(s) ? <JoinCta s={s} /> : <JoinControl s={s} />;
}

export function BrowsePage() {
  const w = useWorld();
  const navigate = useNavigate();
  const [f, setF] = useState<"all" | "open" | "closed">("all");
  const all = w.spaces.filter(
    (s) => !s.archived && (s.vis !== "unlisted" || w.roles[s.id] !== undefined),
  );
  const top = [...all].sort((a, b) => (b.posts ?? 0) - (a.posts ?? 0)).slice(0, 3);
  const list = all.filter((s) => f === "all" || (f === "closed") === isClosed(s));
  const open = (s: Space) => void navigate({ to: "/s/$space", params: { space: s.name } });
  return (
    <Page place={{ kind: "other", label: "Browse spaces" }}>
      <div className="home-wide sub-page br-page">
        <div className="sub-top">
          <h2>Browse spaces</h2>
          <span className="ys-acts">
            <button
              className="btn cs-b"
              type="button"
              onClick={() => void navigate({ to: "/search", search: { q: "" } as never })}
            >
              <span className="d-only">Search</span>
            </button>
            {w.me ? (
              <button
                className="btn"
                type="button"
                onClick={() => void navigate({ to: "/spaces/new" })}
              >
                <span className="d-only">Create a space</span>
                <span className="m-only">Create</span>
              </button>
            ) : null}
          </span>
        </div>
        <section className="br-feat">
          <h3 className="br-h">Most active this week</h3>
          <div className="br-fgrid">
            {top.map((s) => (
              <article
                className="br-fcard"
                key={s.id}
                style={{ ["--band" as string]: `var(--av${s.av || 1})` }}
              >
                <div className="br-fband" />
                <Glyph s={s} className="lg" />
                <div className="br-ch">
                  <button className="dg-name" type="button" onClick={() => open(s)}>
                    {spaceName(s)}
                  </button>
                  <Seal s={s} size="sm" />
                  <Action s={s} />
                </div>
                <p>{s.desc}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="br-grp">
          <div className="cs-brh">
            <h3 className="br-h">All spaces</h3>
            <div className="sv-chips">
              {(
                [
                  ["all", "All", all.length],
                  ["open", "Open", all.filter((s) => !isClosed(s)).length],
                  ["closed", "Closed", all.filter(isClosed).length],
                ] as const
              ).map(([k, l, n]) => (
                <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}>
                  {l} <small className="num">{n}</small>
                </button>
              ))}
            </div>
          </div>
          {list.map((s) => (
            <div className="br-row" key={s.id}>
              <Glyph s={s} />
              <div className="br-nm">
                <span className="cs-nmrow">
                  <button className="dg-name" type="button" onClick={() => open(s)}>
                    {spaceName(s)}
                  </button>
                  <Seal s={s} size="sm" />
                </span>
                <small>{s.desc}</small>
              </div>
              <Action s={s} />
            </div>
          ))}
        </section>
      </div>
    </Page>
  );
}

export function CreateSpacePage() {
  const navigate = useNavigate();
  const write = useWrite();
  const session = useSession();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [rules, setRules] = useState("");
  const [vis, setVis] = useState<"open" | "listed" | "unlisted">("open");
  const [faq, setFaq] = useState(false);
  const [busy, setBusy] = useState(false);
  const closed = vis !== "open";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const create = async () => {
    if (!slug) return;
    setBusy(true);
    const id = session?.newId() ?? "";
    const o = await write(
      "spaces.create",
      {
        id,
        name: slug,
        desc: desc.trim(),
        rules: rules
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean),
        vis,
        ...(closed ? { policy: vis === "unlisted" ? "invite" : "request" } : {}),
        ...(faq ? { faq: true } : {}),
      },
      { quiet: true },
    );
    setBusy(false);
    if (!o.ok) {
      if (o.error) refusalToast(o.error);
      else
        toast(
          "Couldn’t reach the server, so Session didn’t create the space. Try again in a moment.",
        );
      return;
    }
    // the answer carries the new space (2b design finding 6): it shows at
    // once; the logs and the directory are read again behind it
    const made = (o.result as { space?: SpaceRec } | null)?.space;
    if (made && session) session.addSpace(made);
    else await session?.retry();
    if (made) void session?.retry();
    toast(
      `#${slug} is ready. ${closed ? "Invite the first members." : "Share it with people who should join."}`,
    );
    void navigate({ to: "/s/$space", params: { space: slug } });
  };
  const facts: [string, string, string][] = [
    ["Who can read threads", "Anyone", "Members"],
    ["Shown in browse and search", "Yes", vis === "unlisted" ? "No" : "Yes"],
    [
      "Name, description and rules",
      "Anyone",
      vis === "unlisted" ? "Members and invitees" : "Anyone",
    ],
    ["How people join", "Join button", vis === "unlisted" ? "Invite" : "Request or invite"],
  ];
  return (
    <Page place={{ kind: "other", label: "Create a space" }}>
      <div className="home-wide sub-page cs-create">
        <div className="sub-top">
          <h2>Create a space</h2>
        </div>
        <div className="cs-crgrid">
          <div className="cs-set st-stacked cr-form">
            <section className="st-sec">
              <div className="st-head">
                <h3>Basics</h3>
                <p>The name and description people see in browse and at the top of the space.</p>
              </div>
              <div className="st-body">
                <label className="fld">
                  <span>Name</span>
                  <span className="cs-pre">
                    <span>#</span>
                    <input
                      id="cs-crname"
                      type="text"
                      placeholder="field-recordings"
                      autoComplete="off"
                      value={name}
                      onChange={(e) => setName(e.currentTarget.value)}
                    />
                  </span>
                  <small className="faint">Lowercase letters, numbers and hyphens.</small>
                </label>
                <label className="fld">
                  <span>Description</span>
                  <textarea
                    id="cs-crdesc"
                    className="cs-ta"
                    rows={2}
                    placeholder="What the space is for"
                    value={desc}
                    onChange={(e) => setDesc(e.currentTarget.value)}
                  />
                </label>
                <label className="fld">
                  <span>
                    Rules <small className="faint">optional, one per line</small>
                  </span>
                  <textarea
                    id="cs-crrules"
                    className="cs-ta"
                    rows={3}
                    value={rules}
                    onChange={(e) => setRules(e.currentTarget.value)}
                  />
                </label>
              </div>
            </section>
            <section className="st-sec">
              <div className="st-head">
                <h3>Visibility</h3>
                <p>Who can read the space, and whether people who are not members can find it.</p>
              </div>
              <div className="st-body">
                <div className="cs-vrows">
                  <div className="cs-vrow">
                    <div className="cs-vlab">
                      <b>Access</b>
                      <small>Who can read threads, follow-ups and replies.</small>
                    </div>
                    <div className="seg cs-vseg" role="radiogroup" aria-label="Access">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!closed}
                        onClick={() => setVis("open")}
                      >
                        <Svg src={SVG.GLOBE} />
                        Open
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={closed}
                        onClick={() => setVis(closed ? vis : "listed")}
                      >
                        <Svg src={SVG.LOCK} />
                        Closed
                      </button>
                    </div>
                  </div>
                  <div className="cs-vrow">
                    <div className="cs-vlab">
                      <b>Listing</b>
                      <small>
                        {closed
                          ? "Whether the space appears in browse and search."
                          : "Open spaces are always listed."}
                      </small>
                    </div>
                    <div className="seg cs-vseg" role="radiogroup" aria-label="Listing">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={vis !== "unlisted"}
                        disabled={!closed}
                        onClick={() => setVis("listed")}
                      >
                        Listed
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={vis === "unlisted"}
                        disabled={!closed}
                        onClick={() => setVis("unlisted")}
                      >
                        Unlisted
                      </button>
                    </div>
                  </div>
                </div>
                <dl className="cs-vdl">
                  {facts.map(([t, o, c]) => (
                    <Fragment key={t}>
                      <dt>{t}</dt>
                      <dd>{closed ? c : o}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            </section>
            <section className="st-sec">
              <div className="st-head">
                <h3>Landing page</h3>
                <p>What people see first when they open the space.</p>
              </div>
              <div className="st-body">
                <label className="sf-tog">
                  <span className="sf-tog-tx">
                    <b>FAQ landing page</b>
                    <small>
                      The space opens on a search-and-ask box and answers grouped by topic, with
                      recent threads below. Search shows existing answers as people type; asking
                      runs the agent only when nothing matches. The full feed stays one click away
                      under Latest.
                    </small>
                  </span>
                  <span className="ts-sw">
                    <input
                      type="checkbox"
                      aria-label="FAQ landing page"
                      checked={faq}
                      onChange={(e) => setFaq(e.currentTarget.checked)}
                    />
                    <span className="sw-track" aria-hidden="true" />
                  </span>
                </label>
              </div>
            </section>
            <div className="st-end">
              <button
                className="btn ghost"
                type="button"
                onClick={() => void navigate({ to: "/spaces/browse" })}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!slug || busy}
                onClick={() => void create()}
              >
                Create space
              </button>
            </div>
          </div>
          <aside className="cs-crprev" aria-label="Preview">
            <h3 className="cr-pv-t">Preview</h3>
            <div className="br-row">
              <span className="glyph" aria-hidden="true">
                {(slug[0] ?? "n").toUpperCase()}
              </span>
              <div className="br-nm">
                <span className="cs-nmrow">#{slug || "new-space"}</span>
                <small>{desc.trim() || "No description yet."}</small>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </Page>
  );
}

export function ProfilePage({ handle }: { handle: string }) {
  const w = useWorld();
  const now = useNow();
  const write = useWrite();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  useOverlay(menu, () => setMenu(false));
  const data = useRecords(
    (r) => {
      const readable = new Set(w.spaces.filter((s) => canRead(w, s)).map((s) => s.id));
      return {
        profile: r.get("profile", handle) ?? null,
        rows: threadRows(r, readable).filter((t) => t.u === handle),
        muted: r.me ? r.get("mute", `${r.me}:${handle}`) !== undefined : false,
        blocked: r.me ? r.get("block", `${r.me}:${handle}`) !== undefined : false,
      };
    },
    [handle, w.spaces],
  ) ?? { profile: null, rows: [], muted: false, blocked: false };
  const mine = w.me?.u === handle;
  const set = async (name: "mutes.set" | "blocks.set", on: boolean) => {
    setMenu(false);
    const o = await write(name, { handle, on });
    if (o.ok)
      toast(
        name === "mutes.set"
          ? on
            ? `Muted ${handle}. Their threads no longer show in your feeds.`
            : `Unmuted ${handle}.`
          : on
            ? `Blocked ${handle}.`
            : `Unblocked ${handle}.`,
      );
  };
  return (
    <Page place={{ kind: "other", label: handle }}>
      <div className="home-wide sub-page pf-page">
        <div className="pf-head">
          <Avatar u={handle} className="lg" />
          <div>
            <h2>{data.profile?.name || handle}</h2>
            <span className="faint">{handle}</span>
            {data.profile?.bio ? <p>{data.profile.bio}</p> : null}
          </div>
          <span className="grow" />
          {mine ? (
            <button
              className="btn"
              type="button"
              onClick={() => void navigate({ to: "/settings/$tab", params: { tab: "account" } })}
            >
              Edit profile
            </button>
          ) : w.me ? (
            <span className="sf-imw">
              <button
                className="btn sm"
                type="button"
                aria-haspopup="true"
                aria-expanded={menu}
                aria-label="More"
                onClick={() => setMenu((x) => !x)}
              >
                <Svg src={SFI.more} />
              </button>
              {menu ? (
                <>
                  <Scrim onClose={() => setMenu(false)} />
                  <div className="pop cs-pop" role="menu">
                    <button
                      className="um-item"
                      type="button"
                      role="menuitem"
                      onClick={() => void set("mutes.set", !data.muted)}
                    >
                      <Svg src={CI.eyeOff} />
                      <span>{data.muted ? `Unmute ${handle}` : `Mute ${handle}`}</span>
                    </button>
                    <button
                      className="um-item cx-danger-i"
                      type="button"
                      role="menuitem"
                      onClick={() => void set("blocks.set", !data.blocked)}
                    >
                      <Svg src={SFI.flag} />
                      <span>{data.blocked ? `Unblock ${handle}` : `Block ${handle}`}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {data.muted ? (
          <div className="cs-strip">
            You muted {handle}. Their threads don’t show in your feeds.
          </div>
        ) : null}
        {data.blocked ? <div className="cs-strip warn">You blocked {handle}.</div> : null}
        <h3 className="br-h">Threads</h3>
        <div className="sv-list">
          {data.rows.map((t) => {
            const s = w.byId.get(t.s);
            return (
              <article className="sv-row" key={t.id}>
                {s ? <Glyph s={s} /> : null}
                <div className="sv-body">
                  <div className="meta">
                    <span>{s ? spaceName(s) : ""}</span>
                    <span>{ago(t.createdAt, now)}</span>
                  </div>
                  <p className="sv-q">
                    <a
                      className="row-link"
                      href={s ? `/s/${s.name}/t/${t.id}` : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        if (s)
                          void navigate({
                            to: "/s/$space/t/$thread",
                            params: { space: s.name, thread: t.id },
                          });
                      }}
                    >
                      {t.q}
                    </a>
                  </p>
                </div>
              </article>
            );
          })}
          {data.rows.length ? null : (
            <p className="muted">No threads in the spaces you can read.</p>
          )}
        </div>
      </div>
    </Page>
  );
}
