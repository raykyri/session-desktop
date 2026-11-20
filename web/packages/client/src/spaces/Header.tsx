// The header (the mockup's `topHeader`, Nav: Header): the logo, Home and the
// space tabs, then Search, the space switcher, notifications, Saved and the
// account menu. On Mobile Web the tabs are a row of chips under it
// (`.mchips`), and the CSS narrows the rest.

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { logout } from "../api/account.js";
import { count, spaceName } from "../data/format.js";
import { headerSpaces, savedThreads, type Space } from "../data/spaces.js";
import { useRecords, useSession } from "../sync/react.js";
import { useSettingsStore } from "../stores/settings.js";

import { Avatar, Logo, Seal, SpaceGlyph, Lock } from "./atoms.js";
import { CI, I, MI, SVG } from "./icons.js";
import { Bell } from "./Notifications.js";
import { useOverlay } from "./overlay.js";
import { Svg } from "./Svg.js";
import { useWorld } from "./world.js";

/** Where the person is: the header marks it. */
export type Place =
  | { kind: "home" }
  | { kind: "space"; id: string }
  /** A thread of the space: the switcher names the space; no tab is current. */
  | { kind: "thread"; id: string }
  | { kind: "saved" }
  | { kind: "notifications" }
  | { kind: "search" }
  | { kind: "browse" }
  | { kind: "other"; label?: string };

const PLUS = SVG.PLUS;

function TabName({ s }: { s: Space }) {
  return (
    <>
      {spaceName(s)}
      <Seal s={s} size="sm" />
      {s.vis !== "open" ? (
        <Lock className="cs-lk" title={s.vis === "unlisted" ? "Closed, unlisted" : "Closed"} />
      ) : null}
    </>
  );
}

function Switcher({ place }: { place: Place }) {
  const w = useWorld();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useOverlay(open, () => setOpen(false));
  const cur = place.kind === "space" || place.kind === "thread" ? w.byId.get(place.id) : undefined;
  const joined = Object.keys(w.roles).flatMap((id) => w.byId.get(id) ?? []);
  const rest = w.spaces.filter((s) => w.roles[s.id] === undefined);
  const match = (s: Space) => !q.trim() || s.name.includes(q.trim().toLowerCase());
  const go = (s: Space) => {
    setOpen(false);
    void navigate({ to: "/s/$space", params: { space: s.name } });
  };
  const row = (s: Space) =>
    match(s) ? (
      <button
        key={s.id}
        className="pop-row"
        type="button"
        data-name={s.name}
        aria-current={place.kind === "space" && place.id === s.id}
        onClick={() => go(s)}
      >
        <SpaceGlyph s={s} />
        <span className="nm cs-nmrow">
          {spaceName(s)}
          <Seal s={s} size="sm" />
        </span>
        {s.posts !== null ? (
          <span className="num faint" style={{ fontSize: "var(--fs-xs)" }}>
            {count(s.posts)}
          </span>
        ) : null}
      </button>
    ) : null;
  const current =
    place.kind === "saved"
      ? "Saved"
      : place.kind === "notifications"
        ? "Notifications"
        : place.kind === "search"
          ? "Search"
          : place.kind === "browse"
            ? "Browse spaces"
            : place.kind === "other"
              ? (place.label ?? "Home")
              : cur
                ? null
                : "Home";
  return (
    <div className="sw-wrap sw-r">
      <button
        className="btn hb sw-btn"
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Switch space"
        onClick={() => {
          setQ("");
          setOpen((o) => !o);
        }}
      >
        <span className="sw-d">All spaces</span>
        <span className="sw-m">
          {current ?? (cur ? <>{spaceName(cur)}<Seal s={cur} size="sm" /></> : "Home")}
        </span>
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <div className="um-scrim" onClick={() => setOpen(false)} />
          <div className="pop" role="menu">
            <input
              id="sw-q"
              type="search"
              placeholder="Find a space"
              aria-label="Find a space"
              autoComplete="off"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
            />
            {!q.trim() || "home".includes(q.trim().toLowerCase()) ? (
              <button
                className="pop-row"
                type="button"
                data-name="home"
                aria-current={place.kind === "home"}
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/" });
                }}
              >
                <span className="glyph home-g">
                  <Svg src={I.house} />
                </span>
                <span className="nm">Home</span>
              </button>
            ) : null}
            {joined.length && joined.some(match) ? <div className="grp eyebrow">Joined</div> : null}
            {joined.map(row)}
            {rest.length && rest.some(match) ? (
              <div className="grp eyebrow">{joined.length ? "More spaces" : "Spaces"}</div>
            ) : null}
            {rest.map(row)}
            {q.trim() && !w.spaces.some(match) && !"home".includes(q.trim().toLowerCase()) ? (
              <p className="nv-swnone muted">No space matches “{q.trim()}”.</p>
            ) : null}
            {w.me ? (
              <div className="pop-foot pf-pair">
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void navigate({ to: "/spaces/browse" });
                  }}
                >
                  Discover
                </button>
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void navigate({ to: "/spaces/new" });
                  }}
                >
                  <Svg src={PLUS} />
                  Create
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const APS: ["system" | "light" | "dark", string, string][] = [
  [
    "system",
    "System",
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.3"/><path d="M6 13.5h4M8 11v2.5"/></svg>',
  ],
  [
    "light",
    "Light",
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/></svg>',
  ],
  [
    "dark",
    "Dark",
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6z"/></svg>',
  ],
];

function AccountMenu() {
  const w = useWorld();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const appearance = useSettingsStore((s) => s.settings.appearance);
  const patch = useSettingsStore((s) => s.patch);
  useOverlay(open, () => setOpen(false));
  const me = w.me;
  if (!me) return null;
  const go = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };
  const item = (icon: string, label: string, onClick: () => void, extra?: React.ReactNode) => (
    <button className="um-item" type="button" role="menuitem" onClick={onClick}>
      <Svg src={icon} />
      <span>{label}</span>
      {extra}
    </button>
  );
  return (
    <div className="acct">
      <button
        className="me"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account: ${me.u}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar u={me.u} />
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <div className="um-scrim" onClick={() => setOpen(false)} />
          <div className="pop um" role="menu" aria-label="Account">
            <button
              className="um-head"
              type="button"
              role="menuitem"
              aria-label="Your profile"
              onClick={() => go(`/u/${me.u}`)}
            >
              <Avatar u={me.u} className="lg" />
              <span className="um-id">
                <b>{me.name}</b>
                <span>{me.u}</span>
              </span>
            </button>
            <div className="um-sep" />
            {item(CI.bell, "Notifications", () => go("/notifications"))}
            {item(I.mark, "Saved", () => go("/saved"))}
            {item(MI.grid, "Your spaces", () => go("/spaces"))}
            {item(MI.key, "API keys", () => go("/settings/keys"))}
            {item(MI.cog, "Account", () => go("/settings"))}
            {item(MI.kbd, "Keyboard shortcuts", () => setOpen(false), <kbd>?</kbd>)}
            <div className="um-sep" />
            <div className="um-row">
              <span>Appearance</span>
              <div className="seg um-seg um-iseg">
                {APS.map(([k, l, svg]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={appearance === k}
                    aria-label={l}
                    title={l}
                    onClick={() => patch({ appearance: k })}
                  >
                    <Svg src={svg} />
                  </button>
                ))}
              </div>
            </div>
            <div className="um-sep" />
            {item(MI.out, "Sign out", () => {
              setOpen(false);
              void logout().then(() => navigate({ to: "/" }));
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function Header({ place }: { place: Place }) {
  const w = useWorld();
  const navigate = useNavigate();
  const session = useSession();
  const tabs = useMemo(() => headerSpaces(w.spaces, w.roles), [w.spaces, w.roles]);
  const saved = useRecords((r) => savedThreads(r).length, []) ?? 0;
  const searchRef = useRef<HTMLButtonElement>(null);
  const home = place.kind === "home";
  const tab = (s: Space) => (
    <button
      key={s.id}
      className="utab"
      type="button"
      aria-current={place.kind === "space" && place.id === s.id}
      onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
    >
      <TabName s={s} />
    </button>
  );
  const chip = (s: Space) => (
    <button
      key={s.id}
      type="button"
      className="mchip"
      aria-current={place.kind === "space" && place.id === s.id}
      onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
    >
      <TabName s={s} />
    </button>
  );
  void session;
  return (
    <>
      <div className="hdr">
        <button className="logo-btn" type="button" aria-label="Home" onClick={() => void navigate({ to: "/" })}>
          <Logo text="" />
        </button>
        <nav className="hnav" aria-label="Top spaces">
          <button
            className="utab utab-home"
            type="button"
            aria-current={home}
            onClick={() => void navigate({ to: "/" })}
          >
            <Svg src={I.house} />
            Home
          </button>
          <span className="hdr-sep" />
          <div className="hscroll">{tabs.map(tab)}</div>
        </nav>
        <div className="hdr-right">
          <button
            ref={searchRef}
            className="btn hb nv-sbtn"
            type="button"
            aria-label="Search"
            title="Search (/)"
            onClick={() =>
              void navigate({
                to: "/search",
                search: place.kind === "space" ? { in: w.byId.get(place.id)?.name } : {},
              })
            }
          >
            <Svg src={I.search} />
          </button>
          <Switcher place={place} />
          {w.me ? <Bell onPage={place.kind === "notifications"} /> : null}
          {w.me ? (
            <button
              className={`btn${place.kind === "saved" ? " on" : ""}`}
              type="button"
              title="Saved"
              aria-label={saved ? `Saved: ${saved}` : "Saved"}
              onClick={() => void navigate({ to: "/saved" })}
            >
              <Svg src={I.mark} />
              {saved ? <span className="num">{saved}</span> : null}
            </button>
          ) : null}
          {w.me ? (
            <AccountMenu />
          ) : (
            <div className="acct">
              <button
                className="btn hb"
                type="button"
                onClick={() =>
                  void navigate({ to: "/login", search: { redirect: location.pathname + location.search } })
                }
              >
                Log in
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => void navigate({ to: "/login", search: { signup: "1" } })}
              >
                Sign up
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="mchips" role="navigation" aria-label="Spaces">
        <button type="button" className="mchip" aria-current={home} onClick={() => void navigate({ to: "/" })}>
          Home
        </button>
        {tabs.map(chip)}
      </div>
    </>
  );
}
