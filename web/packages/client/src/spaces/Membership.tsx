// Joining and leaving (phase 2b, slice 2): Join and Joined on a space's
// banner, the closed space's join card for people who cannot read it, the
// request form, your request (View, Withdraw), a declined request, and the
// leave dialogs, with the mockup's copy.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { getJson } from "../api/http.js";
import { dayOf, fmt, isClosed, spaceName, visLabel } from "../data/format.js";
import { isStaff, type Space } from "../data/spaces.js";
import { useNow, useRecords } from "../sync/react.js";

import { Modal, NotFound, Page } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Avatar, SpaceGlyph, Seal } from "./atoms.js";
import { CI, I, MI, SVG } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { toast, useWrite } from "./writes.js";

export const policyLabel = (s: Space) =>
  s.policy === "invite" ? "Invite only" : "Join by request";
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", mod: "Moderator" };

/** The person's join request in a space, if any. */
/** When a declined request may be sent again: the request's `retryAt`
 * (the server agent's, phase 2 review round 1; 2b design finding 1), else 14
 * days after it was declined, as the decline dialog says. */
export function retryAtOf(req: { updatedAt: string; retryAt?: string | null }): number {
  const at = req.retryAt ? Date.parse(req.retryAt) : NaN;
  return Number.isFinite(at) ? at : Date.parse(req.updatedAt) + 14 * 864e5;
}

export function useMyRequest(s: Space) {
  const w = useWorld();
  const me = w.me?.u ?? null;
  return (
    useRecords((r) => (me ? (r.get("request", `${s.id}:${me}`) ?? null) : null), [s.id, me]) ?? null
  );
}

function useSignIn() {
  const navigate = useNavigate();
  return () =>
    void navigate({ to: "/login", search: { redirect: location.pathname + location.search } });
}

function agoWords(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <>
      <span style={{ flex: 1 }} />
      {children}
    </>
  );
}

export function Rules({ s }: { s: Space }) {
  return (
    <ol>
      {s.rules.map((r, k) => (
        <li key={k}>{r}</li>
      ))}
    </ol>
  );
}

export function Mods({ s }: { s: Space }) {
  return (
    <div className="mods">
      {s.mods.map(([h, r]) => (
        <div key={h}>
          <Avatar u={h} className="sm" />
          <span>{h}</span>
          <small>{ROLE_LABEL[r] ?? r}</small>
        </div>
      ))}
    </div>
  );
}

/** The space's only owner cannot leave. */
function soleOwner(s: Space, me: string | null): boolean {
  const owners = s.mods.filter(([, r]) => r === "owner").map(([h]) => h);
  return me !== null && owners.length === 1 && owners[0] === me;
}

function LeaveDialog({ s, onClose }: { s: Space; onClose: () => void }) {
  const w = useWorld();
  const write = useWrite();
  const navigate = useNavigate();
  if (soleOwner(s, w.me?.u ?? null))
    return (
      <Modal
        title="Transfer ownership first"
        role="alertdialog"
        onClose={onClose}
        footer={
          <Footer>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                onClose();
                void navigate({
                  to: "/s/$space/manage/$tab",
                  params: { space: s.name, tab: "members" },
                });
              }}
            >
              Go to Members
            </button>
          </Footer>
        }
      >
        <p className="muted">
          You are the only owner of {spaceName(s)}, so you can’t leave it yet. In Manage › Members,
          make an admin the owner, then leave.
        </p>
        <p className="cs-fine">
          <Svg src={SVG.CX_ARCH} />
          <span>
            To stop activity in {spaceName(s)} instead, archive or delete it in Manage › Settings.
          </span>
        </p>
      </Modal>
    );
  const closed = isClosed(s);
  const back =
    s.vis === "unlisted" || s.policy === "invite"
      ? "you’ll need a new invite to join again"
      : "you’ll need to request to join again";
  const leave = async () => {
    onClose();
    const o = await write("spaces.leave", { space: s.id });
    if (o.ok) {
      toast(`You left ${spaceName(s)}.`);
      if (s.vis === "unlisted") void navigate({ to: "/" });
    }
  };
  return (
    <Modal
      title={`Leave ${spaceName(s)}?`}
      role="alertdialog"
      onClose={onClose}
      footer={
        <Footer>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" type="button" onClick={() => void leave()}>
            Leave space
          </button>
        </Footer>
      }
    >
      {closed ? (
        <>
          <p className="muted">
            You’ll lose access to {spaceName(s)}’s threads. Your threads and follow-ups will remain,
            and {back}.
          </p>
          <p className="cs-fine">
            <Svg src={I.mark} />
            <span>Threads from {spaceName(s)} stay in Saved, but you can’t open them.</span>
          </p>
        </>
      ) : (
        <p className="muted">
          You’ll stop seeing {spaceName(s)}’s threads on your Home screen. Your threads and
          follow-ups will remain.
        </p>
      )}
    </Modal>
  );
}

/** Leave, with the leave dialog (Account › Your spaces). */
export function LeaveButton({ s }: { s: Space }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}>
        Leave
      </button>
      {open ? <LeaveDialog s={s} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function JoinDialog({ s, onClose }: { s: Space; onClose: () => void }) {
  const write = useWrite();
  const join = async () => {
    onClose();
    const o = await write("spaces.join", { space: s.id });
    if (o.ok) toast(`You joined ${spaceName(s)}.`);
  };
  return (
    <Modal
      title={`Join ${spaceName(s)}?`}
      onClose={onClose}
      footer={
        <Footer>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={() => void join()}>
            Join
          </button>
        </Footer>
      }
    >
      <p className="muted">
        New threads from {spaceName(s)} show on your Home, and you can ask and post in it.
      </p>
      {s.rules.length ? (
        <div className="cs-jrules">
          <b>Rules</b>
          <Rules s={s} />
        </div>
      ) : null}
    </Modal>
  );
}

/** Join or Joined on the banner: an open space's button, or a closed
 * space's Joined menu (Manage space, Leave space). */
export function JoinControl({ s, compact = false }: { s: Space; compact?: boolean }) {
  const w = useWorld();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const role = w.roles[s.id];
  const [dlg, setDlg] = useState<"join" | "leave" | null>(null);
  const [menu, setMenu] = useState(false);
  useOverlay(menu, () => setMenu(false));
  const dialogs =
    dlg === "join" ? (
      <JoinDialog s={s} onClose={() => setDlg(null)} />
    ) : dlg === "leave" ? (
      <LeaveDialog s={s} onClose={() => setDlg(null)} />
    ) : null;
  if (!isClosed(s)) {
    if (!w.me)
      return (
        <button className="btn primary" type="button" onClick={signIn}>
          Join
        </button>
      );
    return (
      <>
        {role !== undefined ? (
          <button className="btn" type="button" onClick={() => setDlg("leave")}>
            Joined
          </button>
        ) : (
          <button
            className={compact ? "btn primary sm" : "btn primary"}
            type="button"
            onClick={() => setDlg("join")}
          >
            Join
          </button>
        )}
        {dialogs}
      </>
    );
  }
  if (role === undefined) return null;
  return (
    <div className="cs-mw">
      <button
        className="btn cs-b"
        type="button"
        aria-haspopup="true"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        Joined
        <Svg src={I.chev} className="cs-cv" />
      </button>
      {menu ? (
        <>
          <Scrim onClose={() => setMenu(false)} />
          <div className="pop cs-pop" role="menu">
            {isStaff(role) ? (
              <button
                className="um-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  void navigate({
                    to: "/s/$space/manage/$tab",
                    params: { space: s.name, tab: "requests" },
                  });
                }}
              >
                <Svg src={MI.mods} />
                <span>Manage space</span>
              </button>
            ) : null}
            <button
              className="um-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                setDlg("leave");
              }}
            >
              <Svg src={MI.out} />
              <span>Leave space</span>
            </button>
          </div>
        </>
      ) : null}
      {dialogs}
    </div>
  );
}

/** The request form (the mockup's cs-req dialog). */
function RequestDialog({ s, onClose }: { s: Space; onClose: () => void }) {
  const write = useWrite();
  const [answers, setAnswers] = useState<string[]>(() => s.qs.map(() => ""));
  const [rules, setRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid =
    s.qs.every((q, k) => !q.req || (answers[k] ?? "").trim()) && (rules || !s.rules.length);
  const send = async () => {
    if (!valid) return;
    setBusy(true);
    const o = await write("joinRequests.create", {
      space: s.id,
      rulesAccepted: true,
      answers: answers.map((a) => a.trim()),
    });
    setBusy(false);
    if (o.ok) {
      onClose();
      toast(
        `Request sent to the moderators of ${spaceName(s)}. You get a notification when they decide.`,
      );
    }
  };
  return (
    <Modal title={`Request to join ${spaceName(s)}`} onClose={onClose}>
      <div className="cs-form">
        {s.qs.map((q, k) => (
          <label className="fld cs-q" key={k}>
            <span>
              {q.q}
              {q.req ? null : (
                <>
                  {" "}
                  <small className="faint">optional</small>
                </>
              )}
            </span>
            <textarea
              id={`cs-ans-${k}`}
              className="cs-ta"
              rows={2}
              value={answers[k] ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setAnswers((a) => a.map((x, j) => (j === k ? v : x)));
              }}
            />
          </label>
        ))}
        {s.rules.length ? (
          <div className="cs-rules">
            <b>Rules of {spaceName(s)}</b>
            <Rules s={s} />
            <label className="cs-chk">
              <input
                type="checkbox"
                id="cs-rules"
                checked={rules}
                onChange={(e) => setRules(e.currentTarget.checked)}
              />
              <span>I have read the rules</span>
            </label>
          </div>
        ) : null}
        <p className="cs-fine">
          <Svg src={CI.users} />
          <span>
            Moderators see your handle, your X account, your public threads and these answers.
          </span>
        </p>
        <div className="modal-f">
          <span style={{ flex: 1 }} />
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            id="cs-send"
            disabled={!valid || busy}
            onClick={() => void send()}
          >
            Send request
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WithdrawDialog({ s, onClose }: { s: Space; onClose: () => void }) {
  const write = useWrite();
  const withdraw = async () => {
    onClose();
    const o = await write("joinRequests.withdraw", { space: s.id });
    if (o.ok) toast("Request withdrawn.");
  };
  return (
    <Modal
      title="Withdraw your request?"
      role="alertdialog"
      onClose={onClose}
      footer={
        <Footer>
          <button className="btn" type="button" onClick={onClose}>
            Keep request
          </button>
          <button className="btn danger" type="button" onClick={() => void withdraw()}>
            Withdraw
          </button>
        </Footer>
      }
    >
      <p className="muted">
        Moderators of {spaceName(s)} will no longer see it. You can request again at any time.
      </p>
    </Modal>
  );
}

function MyRequestDialog({
  s,
  answers,
  sent,
  onClose,
  onWithdraw,
}: {
  s: Space;
  answers: string[];
  sent: string;
  onClose: () => void;
  onWithdraw: () => void;
}) {
  return (
    <Modal
      title={`Your request to join ${spaceName(s)}`}
      onClose={onClose}
      footer={
        <Footer>
          <button className="btn" type="button" onClick={onWithdraw}>
            Withdraw request
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </Footer>
      }
    >
      <p className="faint cs-small">Sent {sent}. A moderator has not decided yet.</p>
      {s.qs.map((q, k) => (
        <div className="rq-a" key={k}>
          <span className="rq-q">{q.q}</span>
          <p>{answers[k]?.trim() ? answers[k] : <span className="faint">No answer</span>}</p>
        </div>
      ))}
    </Modal>
  );
}

/** The main action on a closed space for someone who is not a member. */
export function JoinCta({ s, compact = false }: { s: Space; compact?: boolean }) {
  const w = useWorld();
  const now = useNow();
  const signIn = useSignIn();
  const req = useMyRequest(s);
  const [dlg, setDlg] = useState<"request" | "mine" | "withdraw" | null>(null);
  const [menu, setMenu] = useState(false);
  useOverlay(menu, () => setMenu(false));
  const dialogs =
    dlg === "request" ? (
      <RequestDialog s={s} onClose={() => setDlg(null)} />
    ) : dlg === "withdraw" ? (
      <WithdrawDialog s={s} onClose={() => setDlg(null)} />
    ) : dlg === "mine" && req ? (
      <MyRequestDialog
        s={s}
        answers={req.a}
        sent={agoWords(req.createdAt, now)}
        onClose={() => setDlg(null)}
        onWithdraw={() => setDlg("withdraw")}
      />
    ) : null;
  if (!w.me)
    return (
      <button className="btn primary" type="button" onClick={signIn}>
        {s.policy === "invite" ? "Log in" : "Log in to request"}
      </button>
    );
  if (w.roles[s.id] !== undefined) return null;
  if (req?.st === "open")
    return (
      <div className="cs-mw">
        <button
          className="btn cs-reqd cs-b"
          type="button"
          aria-haspopup="true"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Svg src={CI.clock} />
          Requested
          <Svg src={I.chev} className="cs-cv" />
        </button>
        {menu ? (
          <>
            <Scrim onClose={() => setMenu(false)} />
            <div className="pop cs-pop" role="menu">
              <button
                className="um-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDlg("mine");
                }}
              >
                <Svg src={I.page} />
                <span>View your request</span>
              </button>
              <button
                className="um-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDlg("withdraw");
                }}
              >
                <Svg src={I.close} />
                <span>Withdraw request</span>
              </button>
            </div>
          </>
        ) : null}
        {dialogs}
      </div>
    );
  if (s.policy === "invite")
    return (
      <span className="cs-invonly">
        <Svg src={SVG.LOCK} />
        Invite only
      </span>
    );
  // a declined request waits 14 days (the mockup's csJoinAct)
  if (req?.st === "declined" && now < retryAtOf(req))
    return (
      <button className="btn" type="button" disabled>
        Request declined
      </button>
    );
  return (
    <>
      <button
        className={compact ? "btn primary sm" : "btn primary"}
        type="button"
        onClick={() => setDlg("request")}
      >
        {/* a list's row (the mockup's csJoinCtl) says Request */}
        {compact ? "Request" : "Request to join"}
      </button>
      {dialogs}
    </>
  );
}

/** A declined request: when, and the moderators' note. */
function DeclinedCard({ s }: { s: Space }) {
  const req = useMyRequest(s);
  const now = useNow();
  if (req?.st !== "declined") return null;
  const again = retryAtOf(req);
  const on = new Date(req.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return (
    <section className="cs-card cs-denied">
      <div className="cs-card-h">
        <b>Your request was declined</b>
        <span className="faint">{on}</span>
      </div>
      <p className="muted">The moderators of {spaceName(s)} declined your request to join.</p>
      {req.why ? (
        <blockquote className="cx-dnote">
          <small className="faint">Note from the moderators</small>
          <p>{req.why}</p>
        </blockquote>
      ) : null}
      <p className="cs-fine">
        <Svg src={CI.clock} />
        <span>
          {now < again
            ? `You can request again on ${dayOf(again, now)}.`
            : "The waiting period has passed. You can send a new request with new answers."}
        </span>
      </p>
    </section>
  );
}

const SKEL = [78, 64, 90, 55, 72, 60];

/** A closed space someone cannot read: placeholder rows behind a card with
 * the space's name, visibility, description, the join action, its rules and
 * its moderators (the mockup's csGateLayout). */
export function JoinCard({ s }: { s: Space }) {
  return (
    <div className="cs-cardpage">
      <div className="cs-prev cs-prev-plain cs-prev-rich">
        <div className="cs-skel" aria-hidden="true">
          {SKEL.map((w, k) => (
            <div className="cs-sk" key={k}>
              <i className="dot" />
              <div>
                <i style={{ width: `${w}%` }} />
                <i style={{ width: `${w - 22}%` }} />
                {k % 2 ? null : <i style={{ width: `${w - 40}%` }} />}
              </div>
            </div>
          ))}
        </div>
        <div className="cs-prev-card">
          <article className="cs-solo">
            <span className="cs-gw">
              <SpaceGlyph s={s} className="xl" />
              <span className="cs-gl" title="Closed">
                <Svg src={SVG.LOCK} />
              </span>
            </span>
            <h2>
              {spaceName(s)}
              <Seal s={s} size="lg" />
            </h2>
            <p className="cs-solo-m">
              <span className="cs-vis">
                <Svg src={s.vis === "unlisted" ? CI.eyeOff : SVG.LOCK} />
                {visLabel(s)}
              </span>
              <span className="num">{fmt(s.members)} members</span>
              <span>{policyLabel(s)}</span>
            </p>
            <p className="cs-solo-d">{s.desc}</p>
            <div className="cs-solo-cta">
              <JoinCta s={s} />
            </div>
            <DeclinedCard s={s} />
            <div className="cs-solo-sec">
              <h3>Rules</h3>
              <Rules s={s} />
            </div>
            <div className="cs-solo-sec">
              <h3>Moderators</h3>
              <Mods s={s} />
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

/** An unlisted space (or its thread) opened without access: its name and
 * nothing else. */
export function NoAccess({ s, thread }: { s: Space; thread: boolean }) {
  const w = useWorld();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const out = !w.me;
  return (
    <div className="cs-napage">
      <div className="cs-na">
        <SpaceGlyph s={s} className="xl" />
        <h2>{spaceName(s)}</h2>
        <p className="cs-solo-m">
          <span className="cs-vis">
            <Svg src={CI.eyeOff} />
            Closed, unlisted
          </span>
        </p>
        <p className="muted">
          Only members can see this {thread ? "thread" : "space"}.{" "}
          {out ? "Log in to check whether you are a member." : "Ask a member for an invite link."}
        </p>
        <div className="cs-na-b">
          {out ? (
            <button className="btn primary" type="button" onClick={signIn}>
              Log in
            </button>
          ) : null}
          <button className="btn" type="button" onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
        </div>
      </div>
    </div>
  );
}

/** A thread link in a closed space the reader cannot read. */
export function ThreadGate({ s }: { s: Space }) {
  const w = useWorld();
  const navigate = useNavigate();
  if (s.vis === "unlisted") return <NoAccess s={s} thread />;
  const open = () => void navigate({ to: "/s/$space", params: { space: s.name } });
  return (
    <div className="cs-napage">
      <div className="cs-na">
        <span className="cs-na-ic">
          <Svg src={SVG.LOCK} />
        </span>
        <h2>This thread is in a closed space</h2>
        <p className="muted">
          {w.me
            ? `Only members of ${spaceName(s)} can read it.`
            : `Log in to check whether you are a member of ${spaceName(s)}.`}
        </p>
        <div className="cs-mini">
          <SpaceGlyph s={s} className="lg" />
          <div>
            <button className="dg-name" type="button" onClick={open}>
              {spaceName(s)}
            </button>
            <p className="cs-solo-m">
              <span className="cs-vis">
                <Svg src={SVG.LOCK} />
                {visLabel(s)}
              </span>
              <span className="num">{fmt(s.members)} members</span>
              <span>{policyLabel(s)}</span>
            </p>
            <p className="muted cs-small">{s.desc}</p>
          </div>
        </div>
        <div className="cs-na-b">
          <JoinCta s={s} />
          <button className="btn" type="button" onClick={open}>
            About the space
          </button>
        </div>
      </div>
    </div>
  );
}

/** A space the directory does not list to this reader (an unlisted space
 * they are not in), looked up by the name in the link: its name and
 * nothing else; no such space, Not found. */
export function MissingSpace({ name, thread }: { name: string; thread: boolean }) {
  const [found, setFound] = useState<Space | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getJson<{ space: { id: string; name: string; vis: Space["vis"]; av: number } }>(
      `/api/spaces/named/${encodeURIComponent(name)}`,
    ).then(
      ({ space: x }) =>
        live &&
        setFound({
          id: x.id,
          name: x.name,
          title: "",
          desc: "",
          vis: x.vis,
          policy: "invite",
          invite: null,
          av: x.av,
          img: false,
          dom: null,
          plain: false,
          faq: false,
          topics: [],
          postsOff: false,
          rules: [],
          qs: [],
          pageEdit: null,
          mods: [],
          members: 0,
          posts: null,
          archived: false,
          createdAt: "",
        }),
      () => live && setFound(null),
    );
    return () => {
      live = false;
    };
  }, [name]);
  if (found === undefined) return <Page place={{ kind: "other" }}>{null}</Page>;
  if (found && found.vis === "unlisted")
    return (
      <Page cls="" place={{ kind: "other" }}>
        <NoAccess s={found} thread={thread} />
      </Page>
    );
  return (
    <Page place={{ kind: "other" }}>
      <NotFound space={name} />
    </Page>
  );
}
