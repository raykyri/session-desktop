// Account (the mockup's acx pages, phase 2b slice 4): `/settings/<tab>` with
// Account (profile and notification email), Usage (included tokens this
// week and each key this month), API keys (add with a monthly limit,
// rename, change the limit, use for asks, check again, replace, revoke) and
// Your spaces; `/device` approves a Desktop app's sign-in; and `/welcome`,
// the first run. The web has no Devices tab: devices are listed in the Phone
// app's Account page (AGENTS.md). Account reads are /api/me/*; changes are
// the online-only calls (apiKeys.*, usage.setDefaultKey, settings.update,
// devices.*) and the profile.update and onboarding.finish mutators.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useMe } from "../api/account.js";
import { getJson } from "../api/http.js";
import { createResource, useResource } from "../api/resource.js";
import { agoText, dayOf, fmtT, spaceName } from "../data/format.js";
import { useNow, useRecords, useSession } from "../sync/react.js";

import { Modal, Page } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Glyph } from "./atoms.js";
import { cx } from "./cx.js";
import { I, MI, SVG, SXI } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { refusalToast, toast, useWrite } from "./writes.js";

// ---- reads ----

export interface ApiKeyView {
  id: string;
  label: string;
  provider: string;
  valid: boolean;
  check?: "checking";
  mask?: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  reason?: string;
  used: number;
  cap: number;
}
interface UsageView {
  cap: number;
  week: number;
  resetAt: string;
  def: string | null;
  by: Record<string, Record<string, number>>;
}
interface AccountSettings {
  emailOn?: boolean;
  email?: string | null;
  emailNew?: string | null;
}

export const keysResource = createResource(() => getJson<ApiKeyView[]>("/api/me/api-keys"));
export const usageResource = createResource(() => getJson<UsageView>("/api/me/usage"));
const settingsResource = createResource(() => getJson<AccountSettings>("/api/me/settings"));

const reloadAccount = () => {
  void keysResource.load(true).catch(() => undefined);
  void usageResource.load(true).catch(() => undefined);
};

const PROVIDER: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};
const provider = (p: string) => PROVIDER[p] ?? p;
const CAPS: [string, string][] = [
  ["0", "No limit"],
  ["250000", "250k tokens"],
  ["500000", "500k tokens"],
  ["1000000", "1M tokens"],
  ["2000000", "2M tokens"],
  ["5000000", "5M tokens"],
];
const capText = (cap: number) => (cap ? `${fmtT(cap)}/mo` : "No limit");

/** An online call: its outcome, a refusal's toast. */
function useCall() {
  const write = useWrite();
  return async (name: string, input: unknown): Promise<unknown> => {
    const o = await write(name, input, { quiet: true });
    if (o.ok) return o.result ?? true;
    if (o.error) refusalToast(o.error);
    else toast("Couldn’t reach the server. Try again in a moment.");
    return null;
  };
}

function Dd({
  id,
  label,
  opts,
  value,
  onPick,
}: {
  id: string;
  label: string;
  opts: [string, string][];
  value: string;
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const cur = opts.find((o) => o[0] === value) ?? opts[0];
  return (
    <div className={cx("dd", open && "open")}>
      <button
        type="button"
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${label} dd-v-${id}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span id={`dd-v-${id}`}>{cur?.[1]}</span>
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="dd-pop" role="listbox" aria-labelledby={label}>
            {opts.map(([v, l]) => (
              <button
                key={v}
                type="button"
                className="dd-o"
                role="option"
                aria-selected={v === value}
                onClick={() => {
                  setOpen(false);
                  onPick(v);
                }}
              >
                <span>{l}</span>
                {v === value ? <Svg src={I.check} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- API keys ----

function AddKey({ onClose, replace }: { onClose: () => void; replace?: ApiKeyView }) {
  const call = useCall();
  const [raw, setRaw] = useState("");
  const [show, setShow] = useState(false);
  const [label, setLabel] = useState("");
  const [cap, setCap] = useState("0");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    const r = replace
      ? await call("apiKeys.replace", { id: replace.id, raw: raw.trim() })
      : await call("apiKeys.create", {
          raw: raw.trim(),
          label: label.trim() || "API key",
          ...(Number(cap) ? { cap: Number(cap) } : {}),
          check: true,
        });
    setBusy(false);
    if (r === null) return;
    reloadAccount();
    onClose();
    toast(
      replace
        ? "Key replaced. Session checks it with the provider."
        : "Key added. Session checks it with the provider.",
    );
  };
  return (
    <Modal
      title={replace ? `Replace ${replace.label}` : "Add an API key"}
      className="sm"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !raw.trim()}
            onClick={() => void save()}
          >
            {replace ? "Replace key" : "Add key"}
          </button>
        </>
      }
    >
      <label className="fld">
        <span>API key</span>
        <span className="fld-pw">
          <input
            id="key-in"
            type={show ? "text" : "password"}
            placeholder="sk-… or AIza…"
            autoComplete="off"
            spellCheck={false}
            value={raw}
            onChange={(e) => setRaw(e.currentTarget.value)}
          />
          <button className="tlink" type="button" onClick={() => setShow((x) => !x)}>
            {show ? "Hide" : "Show"}
          </button>
        </span>
      </label>
      {replace ? null : (
        <>
          <label className="fld">
            <span>
              Name <small className="faint">optional</small>
            </span>
            <input
              id="key-name"
              type="text"
              placeholder="e.g. Personal key"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
            />
          </label>
          <div className="fld">
            <span id="ak-cap-l">
              Monthly limit <small className="faint">optional</small>
            </span>
            <Dd id="acCap" label="ak-cap-l" opts={CAPS} value={cap} onPick={setCap} />
            <small className="faint">
              When asks reach the limit, Session stops using this key until the 1st of the next
              month.
            </small>
          </div>
        </>
      )}
      <p className="ts-help faint">
        Stored encrypted. Session uses it only for asks you start, after your included tokens run
        out or when you pick it. Your provider bills you for the tokens. Session checks the key with
        the provider when you add it.
      </p>
    </Modal>
  );
}

function KeyAction({
  k,
  kind,
  onClose,
}: {
  k: ApiKeyView;
  kind: "rename" | "cap" | "revoke";
  onClose: () => void;
}) {
  const call = useCall();
  const [label, setLabel] = useState(k.label);
  const [cap, setCap] = useState(String(k.cap));
  const go = async () => {
    const r =
      kind === "rename"
        ? await call("apiKeys.rename", { id: k.id, label: label.trim() })
        : kind === "cap"
          ? await call("apiKeys.setCap", { id: k.id, cap: Number(cap) })
          : await call("apiKeys.revoke", { id: k.id });
    if (r === null) return;
    reloadAccount();
    onClose();
    toast(
      kind === "rename"
        ? "Key renamed."
        : kind === "cap"
          ? "Limit changed."
          : `Revoked ${k.label}.`,
    );
  };
  const title =
    kind === "rename"
      ? `Rename ${k.label}`
      : kind === "cap"
        ? `Monthly limit for ${k.label}`
        : `Revoke ${k.label}?`;
  return (
    <Modal
      title={title}
      className="sm"
      role={kind === "revoke" ? "alertdialog" : "dialog"}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={cx("btn", kind === "revoke" ? "danger" : "primary")}
            type="button"
            onClick={() => void go()}
          >
            {kind === "rename" ? "Rename" : kind === "cap" ? "Save" : "Revoke"}
          </button>
        </>
      }
    >
      {kind === "rename" ? (
        <label className="fld">
          <span>Name</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        </label>
      ) : kind === "cap" ? (
        <div className="fld">
          <span id="ak-cap2-l">Monthly limit</span>
          <Dd id="acCap2" label="ak-cap2-l" opts={CAPS} value={cap} onPick={setCap} />
          <small className="faint">
            When asks reach the limit, Session stops using this key until the 1st of the next month.
          </small>
        </div>
      ) : (
        <p className="muted">
          Session deletes the key. Asks it pays for stop; the tokens used this month stay in Usage.
        </p>
      )}
    </Modal>
  );
}

function Keys() {
  const now = useNow();
  const call = useCall();
  const keys = useResource(keysResource);
  const usage = useResource(usageResource);
  const [add, setAdd] = useState(false);
  const [act, setAct] = useState<{
    k: ApiKeyView;
    kind: "rename" | "cap" | "revoke" | "replace";
  } | null>(null);
  const def = usage.data?.def ?? null;
  return (
    <div className="acx-main ak-page">
      <div className="sub-top">
        <h2>API keys</h2>
        <button className="btn primary" type="button" onClick={() => setAdd(true)}>
          Add a key
        </button>
      </div>
      <div className="ak-list">
        {(keys.data ?? []).map((k) => (
          <div className={cx("ak-row", !k.valid && !k.check && "bad")} key={k.id}>
            <span className="ts-ic">
              <Svg src={MI.key} />
            </span>
            <div className="ak-tx">
              <b>{k.label}</b>
              <small>
                {[
                  k.mask,
                  provider(k.provider),
                  k.createdAt ? `Added ${dayOf(k.createdAt, now)}` : null,
                  k.lastUsedAt ? `Last used ${agoText(k.lastUsedAt, now)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              {k.valid ? (
                <span className="ak-use num">
                  {fmtT(k.used)} tokens this month · Limit {capText(k.cap)}
                </span>
              ) : k.reason ? (
                <span className="ak-why">{k.reason}</span>
              ) : null}
            </div>
            {def === k.id ? <span className="ks tm-def">Used for asks</span> : null}
            <span className={cx("ks", k.check ? "" : k.valid ? "ok" : "bad")}>
              {k.check ? "Checking…" : k.valid ? "Active" : "Invalid"}
            </span>
            <span className="ak-acts">
              {k.valid ? (
                <>
                  {def !== k.id ? (
                    <button
                      className="tlink"
                      type="button"
                      onClick={() =>
                        void call("usage.setDefaultKey", { id: k.id }).then((r) => {
                          if (r !== null) reloadAccount();
                        })
                      }
                    >
                      Use for asks
                    </button>
                  ) : null}
                  <button
                    className="tlink"
                    type="button"
                    onClick={() => setAct({ k, kind: "rename" })}
                  >
                    Rename
                  </button>
                  <button
                    className="tlink"
                    type="button"
                    onClick={() => setAct({ k, kind: "cap" })}
                  >
                    Change limit
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="tlink"
                    type="button"
                    onClick={() => setAct({ k, kind: "replace" })}
                  >
                    Replace
                  </button>
                  <button
                    className="tlink"
                    type="button"
                    onClick={() =>
                      void call("apiKeys.check", { id: k.id }).then((r) => {
                        if (r !== null) reloadAccount();
                      })
                    }
                  >
                    Check again
                  </button>
                </>
              )}
              <button
                className="tlink danger-l"
                type="button"
                onClick={() => setAct({ k, kind: "revoke" })}
              >
                Revoke
              </button>
            </span>
          </div>
        ))}
        {keys.data && !keys.data.length ? (
          <div className="ak-row">
            <span className="muted">No API keys yet. Asks use your included tokens.</span>
          </div>
        ) : null}
      </div>
      {add ? <AddKey onClose={() => setAdd(false)} /> : null}
      {act?.kind === "replace" ? <AddKey replace={act.k} onClose={() => setAct(null)} /> : null}
      {act && act.kind !== "replace" ? (
        <KeyAction k={act.k} kind={act.kind} onClose={() => setAct(null)} />
      ) : null}
    </div>
  );
}

// ---- usage ----

function Usage() {
  const now = useNow();
  const usage = useResource(usageResource);
  const keys = useResource(keysResource);
  const u = usage.data;
  const ks = keys.data ?? [];
  const month =
    ks.reduce((n, k) => n + k.used, 0) +
    (u ? Object.values(u.by["session"] ?? {}).reduce((a, b) => a + b, 0) : 0);
  const reset = u ? dayOf(u.resetAt, now) : "";
  const pct = (a: number, b: number) => `${b ? Math.min(100, (a / b) * 100).toFixed(1) : "0"}%`;
  return (
    <div className="acx-main ak-page ac-page tm-upage">
      <div className="sub-top">
        <h2>Usage</h2>
      </div>
      <div className="tm-total">
        <b className="num">{fmtT(month)}</b>
        <span>tokens this month</span>
      </div>
      <p className="muted tm-ulead">
        Included tokens reset {reset}. Your providers bill your keys. Key limits reset on the 1st of
        each month.
      </p>
      <div className="cs-set st-side ac-set">
        <section className="st-sec">
          <div className="st-head">
            <h3>By source</h3>
            <p>The tokens your asks used, by source: included tokens this week, keys this month.</p>
          </div>
          <div className="st-body">
            <div className="tm-rows">
              {u ? (
                <div className="tm-row">
                  <span className="ts-ic">
                    <Svg src={I.agent} />
                  </span>
                  <div className="tm-rt">
                    <b>Included tokens</b>
                    <small>
                      {fmtT(u.week)} of {fmtT(u.cap)} · {fmtT(Math.max(0, u.cap - u.week))} left ·
                      resets {reset}
                    </small>
                    <span className="tm-bar" aria-hidden="true">
                      <i style={{ width: pct(u.week, u.cap) }} />
                    </span>
                  </div>
                  <b className="num">{fmtT(u.week)}</b>
                </div>
              ) : null}
              {ks.map((k) => (
                <div className="tm-row" key={k.id}>
                  <span className="ts-ic">
                    <Svg src={MI.key} />
                  </span>
                  <div className="tm-rt">
                    <b>{k.label}</b>
                    <small>
                      {provider(k.provider)}
                      {u?.def === k.id ? " · Used for asks" : ""}
                      {k.valid
                        ? ` · ${fmtT(k.used)}${k.cap ? ` of a ${fmtT(k.cap)} monthly limit` : ""}`
                        : " · Rejected by the provider"}
                    </small>
                    {k.valid && k.cap ? (
                      <span className="tm-bar" aria-hidden="true">
                        <i style={{ width: pct(k.used, k.cap) }} />
                      </span>
                    ) : null}
                  </div>
                  <b className="num">{fmtT(k.used)}</b>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---- account, spaces ----

function AccountTab() {
  const w = useWorld();
  const write = useWrite();
  const settings = useResource(settingsResource);
  const me = w.me;
  const profile = useRecords((r) => (me ? (r.get("profile", me.u) ?? null) : null), [me?.u]);
  const [name, setName] = useState<string | null>(null);
  const [bio, setBio] = useState<string | null>(null);
  const call = useCall();
  const curName = name ?? profile?.name ?? me?.name ?? "";
  const curBio = bio ?? profile?.bio ?? "";
  const dirty = name !== null || bio !== null;
  return (
    <div className="acx-main ac-page">
      <div className="sub-top">
        <h2>Account</h2>
      </div>
      <div className="cs-set st-side ac-set">
        <section className="st-sec">
          <div className="st-head">
            <h3>Profile</h3>
            <p>Your name and bio show on your profile and next to what you write.</p>
          </div>
          <div className="st-body">
            <label className="fld">
              <span>Name</span>
              <input
                id="ac-name"
                type="text"
                value={curName}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <label className="fld">
              <span>Bio</span>
              <textarea
                id="ac-bio"
                className="cs-ta"
                rows={3}
                value={curBio}
                onChange={(e) => setBio(e.currentTarget.value)}
              />
            </label>
            <div className="cs-row">
              <button
                className="btn primary"
                type="button"
                disabled={!dirty}
                onClick={() =>
                  void write("profile.update", { name: curName.trim(), bio: curBio.trim() }).then(
                    (o) => {
                      if (o.ok) {
                        setName(null);
                        setBio(null);
                        toast("Profile saved.");
                      }
                    },
                  )
                }
              >
                Save profile
              </button>
            </div>
          </div>
        </section>
        <section className="st-sec">
          <div className="st-head">
            <h3>Notifications</h3>
            <p>What Session sends to your email.</p>
          </div>
          <div className="st-body">
            <label className="sf-tog">
              <span className="sf-tog-tx">
                <b>Email notifications</b>
                <small>Answers to your asks, replies, and decisions on your requests.</small>
              </span>
              <span className="ts-sw">
                <input
                  type="checkbox"
                  aria-label="Email notifications"
                  checked={settings.data?.emailOn ?? false}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    void call("settings.update", { emailOn: on }).then((r) => {
                      if (r !== null) void settingsResource.load(true);
                    });
                  }}
                />
                <span className="sw-track" aria-hidden="true" />
              </span>
            </label>
          </div>
        </section>
        <section className="st-sec">
          <div className="st-head">
            <h3>Export your data</h3>
            <p>A file with your threads, follow-ups, replies and settings.</p>
          </div>
          <div className="st-body">
            <button
              className="btn"
              type="button"
              onClick={() =>
                void call("settings.update", { export: true }).then((r) => {
                  if (r !== null)
                    toast("Export requested. Session emails you a link when it is ready.");
                })
              }
            >
              Request an export
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function YourSpaces() {
  const w = useWorld();
  const navigate = useNavigate();
  const mine = w.spaces.filter((s) => w.roles[s.id] !== undefined);
  const ROLE: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    mod: "Moderator",
    member: "Member",
  };
  return (
    <div className="acx-main ac-page">
      <div className="sub-top">
        <h2>Your spaces</h2>
      </div>
      <div className="ak-list">
        {mine.map((s) => (
          <div className="ak-row" key={s.id}>
            <Glyph s={s} />
            <div className="ak-tx">
              <button
                className="tlink"
                type="button"
                onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
              >
                {spaceName(s)}
              </button>
              <small>{ROLE[w.roles[s.id] ?? "member"]}</small>
            </div>
          </div>
        ))}
        {mine.length ? null : (
          <div className="ak-row">
            <span className="muted">You haven’t joined any spaces yet.</span>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: [string, string][] = [
  ["account", "Account"],
  ["usage", "Usage"],
  ["keys", "API keys"],
  ["spaces", "Your spaces"],
];

export function AccountPage({ tab }: { tab: string }) {
  const w = useWorld();
  const navigate = useNavigate();
  const me = useMe();
  if (!w.me) {
    if (me.status === "loading" || me.status === "idle")
      return <Page place={{ kind: "other" }}>{null}</Page>;
    return (
      <Page place={{ kind: "other" }}>
        <div className="cs-napage">
          <div className="cs-na">
            <h2>Account</h2>
            <p className="muted">Log in to see your account, usage and API keys.</p>
            <div className="cs-na-b">
              <button
                className="btn primary"
                type="button"
                onClick={() =>
                  void navigate({ to: "/login", search: { redirect: `/settings/${tab}` } })
                }
              >
                Log in
              </button>
            </div>
          </div>
        </div>
      </Page>
    );
  }
  const body: Record<string, ReactNode> = {
    account: <AccountTab />,
    usage: <Usage />,
    keys: <Keys />,
    spaces: <YourSpaces />,
  };
  return (
    <Page place={{ kind: "other" }}>
      <div className="home-wide sub-page acx-page acx-tabs-v">
        <div className="nv-backrow">
          <button
            className="th-back nv-back"
            type="button"
            onClick={() => void navigate({ to: "/" })}
          >
            <Svg src={I.chev} className="bk" />
            <span className="nv-bl">Home</span>
          </button>
        </div>
        <h1 className="acx-title">Account</h1>
        <nav className="acx-tabs" aria-label="Account sections">
          {TABS.map(([k, l]) => (
            <button
              key={k}
              className="acx-tab"
              type="button"
              aria-current={tab === k ? "page" : false}
              onClick={() => void navigate({ to: "/settings/$tab", params: { tab: k } })}
            >
              {l}
            </button>
          ))}
        </nav>
        {body[tab] ?? body["account"]}
      </div>
    </Page>
  );
}

// ---- a Desktop app's sign-in ----

/** `devices.request`: what the page shows about a sign-in the app started.
 * `sameComputer`: the request came from this browser's network address, so
 * one click approves it; otherwise the page asks for the code the app shows
 * (phase 2 review round 1, finding 1: a link someone else sent cannot sign
 * their Mac in as the reader). */
interface SignInRequest {
  device: string;
  app: string;
  askedAt: string | number;
  sameComputer: boolean;
}

const CODE_WRONG =
  "This code doesn’t match the one on your Mac. Check the code in the Session app and try again.";

/** "Just now", "3m ago". */
const askedText = (at: string | number, now: number) => {
  const t = agoText(at, now);
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
};

export function DevicePage({ request, code: code0 }: { request?: string; code?: string }) {
  const w = useWorld();
  const session = useSession();
  const now = useNow();
  const navigate = useNavigate();
  const write = useWrite();
  const [info, setInfo] = useState<SignInRequest | "gone" | "unknown" | null>(null);
  const [code, setCode] = useState(code0 ?? "");
  const [codeErr, setCodeErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!w.me && w.loaded)
      void navigate({ to: "/login", search: { redirect: location.pathname + location.search } });
  }, [w.me, w.loaded, navigate]);
  // the request as the server recorded it: the device, the app, when, and
  // whether it came from this computer
  const client = session?.client ?? null;
  useEffect(() => {
    if (!request || !client) return;
    let live = true;
    void client
      .call("devices.request", { request })
      .then((a) => {
        if (!live) return;
        if (a.ok) setInfo(a.result as SignInRequest);
        else setInfo(a.error.code === "NOT_FOUND" ? "gone" : "unknown");
      })
      .catch(() => live && setInfo("unknown"));
    return () => {
      live = false;
    };
  }, [request, client]);
  // a request the page could not read asks for the code
  const here = typeof info === "object" && info !== null && info.sameComputer;
  const needsCode = !here;
  const answer = async (deny: boolean) => {
    if (!request || busy) return;
    const sent = code.trim();
    if (!deny && needsCode && !sent) return;
    setBusy(true);
    const o = await write(
      "devices.approve",
      { request, ...(deny ? { deny: true } : needsCode ? { code: sent } : {}) },
      { quiet: true },
    );
    setBusy(false);
    if (o.ok) {
      setDone(deny ? "denied" : "approved");
      if (!deny) toast("Signed in successfully.");
    } else if (o.error?.code === "BAD_REQUEST" && !deny) {
      setCodeErr(true);
      setTimeout(() => field.current?.focus(), 0);
    } else if (o.error?.code === "NOT_FOUND") setInfo("gone");
    else if (o.error) refusalToast(o.error);
    else toast("Couldn’t reach the server. Try again in a moment.");
  };
  const card =
    typeof info === "object" && info !== null ? (
      <section className="cs-card sx-dcard">
        <dl className="sx-dl2">
          <dt>Device</dt>
          <dd>{info.device}</dd>
          <dt>App</dt>
          <dd>{info.app}</dd>
          <dt>Asked</dt>
          <dd>
            {askedText(info.askedAt, now)}, from {here ? "this computer" : "another computer"}
          </dd>
        </dl>
      </section>
    ) : null;
  return (
    <Page place={{ kind: "other" }}>
      <div className="cs-napage sx-sign">
        <div className="cs-na">
          {done === "approved" ? (
            <>
              <span className="cs-na-ic">
                <Svg src={I.check} />
              </span>
              <h2>This Mac is signed in</h2>
              <p className="muted">Go back to the Session app. You can close this tab.</p>
            </>
          ) : done === "denied" ? (
            <>
              <span className="cs-na-ic">
                <Svg src={SXI.ban} />
              </span>
              <h2>Sign-in denied</h2>
              <p className="muted">
                The app on that Mac was not signed in. You can close this tab.
              </p>
            </>
          ) : !request || info === "gone" ? (
            <>
              <span className="cs-na-ic">
                <Svg src={SXI.mac} />
              </span>
              <h2>No sign-in to approve</h2>
              <p className="muted">
                {request
                  ? "The server has no record of this sign-in. It may have expired. Start again in the Session app on your Mac."
                  : "Open this page from the Session app on your Mac: it adds the sign-in to the link."}
              </p>
            </>
          ) : info === null ? (
            <span className="cs-na-ic">
              <Svg src={SXI.mac} />
            </span>
          ) : (
            <>
              <span className="cs-na-ic">
                <Svg src={SXI.mac} />
              </span>
              <h2>Sign in on a Mac?</h2>
              <p className="muted">
                The Session app on a Mac asked to sign in as {w.me?.u}.{" "}
                {here
                  ? "Approve only if you just started this on your own Mac."
                  : "The request came from another computer. Enter the code the Session app shows on the Mac. If you didn’t start this sign-in, deny it."}
              </p>
              {card}
              {needsCode ? (
                <>
                  <label className="fld sx-dcode">
                    <span>The code the Mac shows</span>
                    <input
                      id="sx-dcode"
                      ref={field}
                      className="num"
                      type="text"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      spellCheck={false}
                      placeholder="ABC-DEF"
                      maxLength={9}
                      value={code}
                      aria-invalid={codeErr || undefined}
                      aria-describedby={codeErr ? "sx-derr" : undefined}
                      onChange={(e) => {
                        setCode(e.currentTarget.value);
                        setCodeErr(false);
                      }}
                    />
                  </label>
                  {codeErr ? (
                    <p className="ts-err" id="sx-derr" role="alert">
                      {CODE_WRONG}
                    </p>
                  ) : null}
                </>
              ) : null}
              <div className="cs-na-b">
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void answer(true)}
                >
                  Deny
                </button>
                <button
                  className="btn primary"
                  type="button"
                  id="sx-dok"
                  disabled={busy || (needsCode && !code.trim())}
                  onClick={() => void answer(false)}
                >
                  Approve this Mac
                </button>
              </div>
              <p className="cs-fine">
                <Svg src={SVG.LOCK} />
                <span>
                  The app gets a device token for your account. It can read and write what you can,
                  until you revoke it.
                </span>
              </p>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

// ---- the first run ----

export function WelcomePage() {
  const w = useWorld();
  const navigate = useNavigate();
  const write = useWrite();
  const [step, setStep] = useState<"terms" | "spaces" | "key">("terms");
  const [agree, setAgree] = useState(false);
  const [add, setAdd] = useState(false);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const open = w.spaces.filter((s) => s.vis === "open").slice(0, 8);
  // the spaces picked are joined when the first run ends
  const finish = async () => {
    await write("onboarding.finish", { spaces: [...pick] }, { quiet: true });
    void navigate({ to: "/" });
  };
  return (
    <Page place={{ kind: "other" }}>
      <div className="cs-napage">
        <div className="cs-na">
          {step === "terms" ? (
            <>
              <h2>Welcome to Session</h2>
              <p className="muted">
                Ask questions that an agent researches with sources, and read and post in spaces
                with other people.
              </p>
              <label className="cs-chk">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.currentTarget.checked)}
                />
                <span>I accept the terms of use and the privacy policy</span>
              </label>
              <div className="cs-na-b">
                <button
                  className="btn primary"
                  type="button"
                  disabled={!agree}
                  onClick={() => setStep("spaces")}
                >
                  Continue
                </button>
              </div>
            </>
          ) : step === "spaces" ? (
            <>
              <h2>Join spaces</h2>
              <p className="muted">New threads from the spaces you join show on your Home.</p>
              <div className="ak-list">
                {open.map((s) => (
                  <div className="ak-row" key={s.id}>
                    <Glyph s={s} />
                    <div className="ak-tx">
                      <b>{spaceName(s)}</b>
                      <small>{s.desc}</small>
                    </div>
                    {w.roles[s.id] !== undefined ? (
                      <span className="ks ok">Joined</span>
                    ) : (
                      <button
                        className={cx("btn sm", !pick.has(s.id) && "primary")}
                        type="button"
                        aria-pressed={pick.has(s.id)}
                        onClick={() =>
                          setPick((x) => {
                            const y = new Set(x);
                            if (y.has(s.id)) y.delete(s.id);
                            else y.add(s.id);
                            return y;
                          })
                        }
                      >
                        {pick.has(s.id) ? "Joined" : "Join"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="cs-na-b">
                <button className="btn primary" type="button" onClick={() => setStep("key")}>
                  Continue
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Add an API key (optional)</h2>
              <p className="muted">
                Your asks use included tokens first. With a key of your own, asks go on when they
                run out; your provider bills you.
              </p>
              <div className="cs-na-b">
                <button className="btn" type="button" onClick={() => void finish()}>
                  Skip
                </button>
                <button className="btn primary" type="button" onClick={() => setAdd(true)}>
                  Add a key
                </button>
              </div>
              {add ? (
                <AddKey
                  onClose={() => {
                    setAdd(false);
                    void finish();
                  }}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
