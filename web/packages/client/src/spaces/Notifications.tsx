// Notifications: the bell's popover and the Notifications page. The server
// stores a notification without text (`notif` records in the person's user
// log); its text and icon come from its type here, as the mockup's `ntView`
// writes them. Open join requests and open reports are not stored: a
// moderator sees one summary item per space.

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { ago } from "../data/format.js";
import {
  notificationsOf,
  staffNotices,
  type Notification,
  type Role,
  type Space,
} from "../data/spaces.js";
import { useRecords, useNow, useSession } from "../sync/react.js";
import type { Reader } from "../sync/reader.js";

import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Avatar } from "./atoms.js";
import { cx } from "./cx.js";
import { CI, I, SFI, SVG } from "./icons.js";
import { BackRow } from "./nav.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Kind = "reply" | "invite" | "approved" | "declined" | "resolved" | "mi" | "reqs" | "reps";

const KIND: Record<string, Kind> = {
  follow_up: "reply",
  branch: "reply",
  answer_ready: "reply",
  answer_failed: "reply",
  invite: "invite",
  join_approved: "approved",
  join_declined: "declined",
  report_resolved: "resolved",
  source_edited: "mi",
  source_asked: "mi",
  report: "reps",
};

const REP_DONE: Record<string, string> = {
  dismissed: "no action was needed",
  hidden: "the item was hidden",
  removed: "the item was removed",
};

/** One notification as a screen shows it. */
export interface Item {
  id: string;
  k: Kind;
  u: string | null;
  sp: string | null;
  createdAt: string;
  unread: boolean;
  text: ReactNode;
  why?: string;
  icon?: string;
  done?: string;
  /** Where it opens: a thread (and an ask in it), a space's queue, a space. */
  open: { thread?: string; node?: string; space?: string; manage?: "requests" | "reports" } | null;
}

interface Labels {
  thread: (id: string | null) => { title: string; q: string; sp: string | null } | null;
  space: (id: string | null) => Space | undefined;
  followupQ: (id: string | null) => { q: string; par: string | null } | null;
}

/** What the items need from the records: the threads and asks they name. */
function labelsOf(r: Reader, list: Notification[]) {
  const threads: Record<string, { title: string; q: string; sp: string }> = {};
  const fus: Record<string, { q: string; par: string | null }> = {};
  for (const n of list) {
    if (n.thread) {
      const t = r.get("thread", n.thread);
      if (t) threads[t.id] = { title: t.t ?? t.q, q: t.q, sp: t.s };
    }
    for (const id of [n.node, n.item?.startsWith("followup:") ? n.item.slice(9) : null]) {
      if (!id || id === "r") continue;
      const f = r.get("followup", id);
      if (f) {
        fus[f.id] = { q: f.q, par: f.par };
        if (f.par) {
          const p = r.get("followup", f.par);
          if (p) fus[p.id] = { q: p.q, par: p.par };
        }
      }
    }
  }
  return { threads, fus };
}

function itemOf(n: Notification, L: Labels, spaceName: (s: Space | undefined) => string): Item {
  const k = KIND[n.type] ?? "reply";
  const base: Item = {
    id: n.id,
    k,
    u: n.actor,
    sp: n.sp,
    createdAt: n.createdAt,
    unread: !n.read,
    text: "",
    open: n.thread ? { thread: n.thread } : n.sp ? { space: n.sp } : null,
  };
  if (n.response) base.done = n.response === "accepted" ? "Accepted" : "Declined";
  const th = L.thread(n.thread);
  const ask = <b>{th ? clip(th.title, 60) : "a deleted thread"}</b>;
  const answer = <b>{th ? clip(th.q, 60) : "a deleted thread"}</b>;
  const spB = <b>{spaceName(L.space(n.sp))}</b>;
  switch (n.type) {
    case "follow_up":
      return { ...base, text: <>followed up on your ask {ask}</> };
    case "branch": {
      const x = L.followupQ(n.node);
      const up = x?.par ? L.followupQ(x.par) : null;
      return {
        ...base,
        why: x?.q ?? "",
        open: n.thread ? { thread: n.thread, ...(n.node ? { node: n.node } : {}) } : null,
        text: (
          <>
            asked about your ask <b>{up ? up.q : (th?.q ?? "")}</b>
          </>
        ),
      };
    }
    case "answer_ready":
      return { ...base, icon: I.agent, text: <>The agent answered your ask {answer}</> };
    case "answer_failed":
      return { ...base, icon: I.agent, text: <>The agent couldn’t finish your ask {answer}</> };
    case "invite":
      return { ...base, text: <>invited you to join {spB}</> };
    case "join_approved":
      return { ...base, text: <>approved your request to join {spB}</> };
    case "join_declined":
      return { ...base, text: <>Your request to join {spB} was declined.</> };
    case "report_resolved": {
      const noun = n.item?.startsWith("reply:")
        ? "reply"
        : n.item?.startsWith("followup:")
          ? "follow-up"
          : th && n.item === `thread:${n.thread ?? ""}`
            ? "post"
            : "answer";
      return {
        ...base,
        text: (
          <>
            Your report on the {noun} in <b>{clip(th?.q ?? "", 60)}</b> was resolved:{" "}
            {REP_DONE[n.outcome ?? "dismissed"]}.
          </>
        ),
      };
    }
    default:
      return { ...base, text: n.type };
  }
}

/** The person's notification items, newest first, with the staff summaries
 * first, as the mockup lists them. */
export function useNotificationItems(): { items: Item[]; unread: number } {
  const w = useWorld();
  const data = useRecords(
    (r) => {
      const list = notificationsOf(r);
      return { list, labels: labelsOf(r, list), staff: staffNotices(r, w.roles) };
    },
    [w.roles],
  );
  return useMemo(() => {
    if (!data) return { items: [], unread: 0 };
    const name = (s: Space | undefined) =>
      s ? (s.plain && s.dom?.state === "ok" ? s.title : `#${s.name}`) : "a space";
    const L: Labels = {
      thread: (id) => (id ? (data.labels.threads[id] ?? null) : null),
      space: (id) => (id ? w.byId.get(id) : undefined),
      followupQ: (id) => (id ? (data.labels.fus[id] ?? null) : null),
    };
    const reqs: Item[] = data.staff.reqs.map((x) => ({
      id: `nreq:${x.sp}`,
      k: "reqs",
      u: null,
      sp: x.sp,
      createdAt: x.at,
      unread: !data.staff.reqSeen,
      open: { space: x.sp, manage: "requests" },
      text: (
        <>
          {x.n} {x.n === 1 ? "person" : "people"} asked to join <b>{name(w.byId.get(x.sp))}</b>
        </>
      ),
    }));
    const reps: Item[] = data.staff.reps.map((x) => ({
      id: `nrep:${x.sp}`,
      k: "reps",
      u: null,
      sp: x.sp,
      createdAt: x.at,
      unread: !data.staff.repSeen,
      open: { space: x.sp, manage: "reports" },
      text: (
        <>
          {x.n} open report{x.n === 1 ? "" : "s"} in <b>{name(w.byId.get(x.sp))}</b>
        </>
      ),
    }));
    const items = [
      ...reqs,
      ...reps,
      ...data.list.filter((n) => n.type !== "report").map((n) => itemOf(n, L, name)),
    ];
    return { items, unread: items.filter((x) => x.unread).length };
  }, [data, w.byId]);
}

/** Open an item: mark it read, then go where it points. */
function useOpenItem() {
  const session = useSession();
  const navigate = useNavigate();
  const w = useWorld();
  return (x: Item) => {
    if (x.k === "reqs" || x.k === "reps")
      session?.write("notifications.markSeen", { kind: x.k === "reqs" ? "requests" : "reports" });
    else if (x.unread) session?.write("notifications.markRead", { id: x.id });
    const sp = x.open?.space ? w.byId.get(x.open.space) : undefined;
    if (x.open?.thread) {
      const t = session?.reader().get("thread", x.open.thread);
      const space = t ? w.byId.get(t.s) : undefined;
      if (space)
        void navigate({
          to: x.open.node ? "/s/$space/t/$thread/a/$node" : "/s/$space/t/$thread",
          params: { space: space.name, thread: x.open.thread, node: x.open.node ?? "" },
          state: { from: { label: "Notifications", to: "/notifications" }, focus: true } as never,
        });
      return;
    }
    if (sp && x.open?.manage)
      void navigate({
        to: "/s/$space/manage/$tab",
        params: { space: sp.name, tab: x.open.manage },
      });
    else if (sp) void navigate({ to: "/s/$space", params: { space: sp.name } });
  };
}

function ItemIcon({ x }: { x: Item }) {
  const src = x.icon
    ? x.icon
    : x.k === "reqs"
      ? CI.users
      : x.k === "declined"
        ? SVG.LOCK
        : x.k === "reps" || x.k === "resolved"
          ? SFI.flag
          : null;
  if (src)
    return (
      <span className="nt-ic">
        <Svg src={src} />
      </span>
    );
  return <Avatar u={x.u ?? "?"} />;
}

export function NotificationItem({ x, onOpen }: { x: Item; onOpen: (x: Item) => void }) {
  const now = useNow();
  const session = useSession();
  const who = x.u && x.k !== "declined" ? <b>{x.u}</b> : null;
  return (
    <div className={cx("nt-item", x.unread && "unread")}>
      <ItemIcon x={x} />
      <span className="nt-b">
        <button className="nt-tx nt-open" type="button" onClick={() => onOpen(x)}>
          {who}
          {who ? " " : null}
          {x.text}
        </button>
        {x.why ? <span className="nt-q">{x.why}</span> : null}
        <span className="nt-age">{ago(x.createdAt, now, "just now")}</span>
        {x.k === "invite" && !x.done ? (
          <span className="nt-acts">
            <button
              className="btn sm primary"
              type="button"
              onClick={() =>
                x.sp && session?.write("spaces.join", { space: x.sp, notification: x.id })
              }
            >
              Accept
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => session?.write("invites.decline", { notification: x.id })}
            >
              Decline
            </button>
          </span>
        ) : x.k === "invite" ? (
          <span className="nt-done">{x.done}</span>
        ) : x.k === "reqs" ? (
          <span className="nt-acts">
            <button className="btn sm" type="button" onClick={() => onOpen(x)}>
              Review requests
            </button>
          </span>
        ) : x.k === "reps" ? (
          <span className="nt-acts">
            <button className="btn sm" type="button" onClick={() => onOpen(x)}>
              Review reports
            </button>
          </span>
        ) : null}
      </span>
      {x.unread ? <span className="nt-u" aria-label="Unread" /> : null}
    </div>
  );
}

function markAllRead(session: ReturnType<typeof useSession>, items: Item[]) {
  if (!session) return;
  if (items.some((x) => x.unread && x.k !== "reqs" && x.k !== "reps"))
    session.write("notifications.markAllRead", {});
  for (const k of ["reqs", "reps"] as const)
    if (items.some((x) => x.k === k && x.unread))
      session.write("notifications.markSeen", { kind: k === "reqs" ? "requests" : "reports" });
}

/** The bell in the header, with its popover. */
export function Bell({ onPage }: { onPage: boolean }) {
  const [open, setOpen] = useState(false);
  const { items, unread } = useNotificationItems();
  const session = useSession();
  const navigate = useNavigate();
  const openItem = useOpenItem();
  useOverlay(open, () => setOpen(false));
  return (
    <div className="nt-wrap">
      <button
        className={cx("btn hb nt-btn", (open || onPage) && "on")}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <Svg src={CI.bell} />
        {unread ? <span className="num">{unread}</span> : null}
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop nt-pop" role="dialog" aria-label="Notifications">
            <div className="nt-h">
              <b>Notifications</b>
              {unread ? (
                <button className="tlink" type="button" onClick={() => markAllRead(session, items)}>
                  Mark all as read
                </button>
              ) : null}
            </div>
            <div className="nt-list">
              {items.length ? (
                items.map((x) => (
                  <NotificationItem
                    key={x.id}
                    x={x}
                    onOpen={(i) => {
                      setOpen(false);
                      openItem(i);
                    }}
                  />
                ))
              ) : (
                <p className="muted nt-empty">No notifications.</p>
              )}
            </div>
            <div className="nt-f">
              <button
                className="tlink"
                type="button"
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/notifications" });
                }}
              >
                See all notifications
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

type Filter = "all" | "spaces" | "threads";

/** The Notifications page. */
export function NotificationsPage() {
  const [f, setF] = useState<Filter>("all");
  const { items, unread } = useNotificationItems();
  const session = useSession();
  const openItem = useOpenItem();
  const list = items.filter(
    (x) => f === "all" || (f === "spaces" ? x.k !== "reply" : x.k === "reply"),
  );
  const chip = (k: Filter, l: string) => (
    <button type="button" aria-pressed={f === k} onClick={() => setF(k)}>
      {l}
    </button>
  );
  return (
    <div className="home-wide sub-page nt-page">
      <BackRow />
      <div className="sub-top">
        <h2>Notifications</h2>
        {unread ? (
          <button className="btn" type="button" onClick={() => markAllRead(session, items)}>
            Mark all as read
          </button>
        ) : null}
      </div>
      <div className="sv-chips">
        {chip("all", "All")}
        {chip("spaces", "Spaces and requests")}
        {chip("threads", "Threads")}
      </div>
      <div className="nt-list">
        {list.length ? (
          list.map((x) => <NotificationItem key={x.id} x={x} onOpen={openItem} />)
        ) : (
          <p className="muted nt-empty">No notifications.</p>
        )}
      </div>
    </div>
  );
}

export type { Role };
