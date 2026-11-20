// A space's Manage page for its staff (the mockup's layoutManage): Requests
// (approve, decline with a note, undo a decline), Reports (dismiss, hide,
// remove), Members (roles, remove, ban, unban) and Invites (one-time links).
// Each action is a write; approving and reopening send the request's rev as
// the moderator saw it, so a request that changed meanwhile is refused as
// STALE: a toast says so, the card shows the request as it is now, and
// nothing is applied again (AGENTS.md; the mockup's sx-rf-approve).

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  agoText,
  ago,
  dayOf,
  fmt,
  isClosed,
  plainText,
  spaceName,
  visLabel,
} from "../data/format.js";
import { isStaff, moderated, type Moderated, type Role, type Space } from "../data/spaces.js";
import { useNow, useRecords, useSession } from "../sync/react.js";
import type { Reader } from "../sync/reader.js";

import { Modal, NotFound, Page } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { SkillsManage } from "./Skills.js";
import { SourcesManage } from "./Sources.js";
import { SettingsManage } from "./SpaceSettings.js";
import { Svg } from "./Svg.js";
import { Author, Avatar } from "./atoms.js";
import { cx } from "./cx.js";
import { CI, I, MI, SFI, SVG } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { refusalToast, toast, useWrite } from "./writes.js";

export type ManageTab =
  "requests" | "reports" | "members" | "invites" | "skills" | "sources" | "settings";

const ROLES: [Role, string][] = [
  ["member", "Member"],
  ["mod", "Moderator"],
  ["admin", "Admin"],
];
const RANK: Record<string, number> = { member: 0, mod: 1, admin: 2, owner: 3 };
const CAN: Record<string, string> = {
  member: "post and ask",
  mod: "approve requests, handle reports and remove members",
  admin: "approve requests, handle reports, remove members and change roles and settings",
};
export const REP_WHY: [string, string, string][] = [
  ["incorrect", "Incorrect", "It states something that is wrong."],
  ["old", "Out of date", "It was correct but no longer is."],
  ["offensive", "Offensive or spam", "Abuse, harassment, advertising or spam."],
  ["other", "Other", "Something else. Describe it in the note."],
];
const repWhy = (k: string) => (REP_WHY.find((x) => x[0] === k) ?? REP_WHY[3])?.[1] ?? k;
const REP_DONE: Record<string, [string, string]> = {
  dismissed: ["Dismissed", "the moderators kept it as it is"],
  hidden: ["Hidden", "a moderator hid it"],
  removed: ["Removed", "a moderator removed it"],
};
const clip = (t: string, n = 150) =>
  t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t;

function Foot({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span style={{ flex: 1 }} />
      {children}
    </>
  );
}

// ---- requests ----

function Requests({ s }: { s: Space }) {
  const now = useNow();
  const write = useWrite();
  const reqs =
    useRecords((r) => r.list("request", (q) => q.sp === s.id), [s.id])?.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    ) ?? [];
  const open = reqs.filter((r) => r.st === "open");
  const decided = reqs.filter((r) => r.st !== "open" && now - Date.parse(r.updatedAt) < 864e5);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<{ k: "approve" | "decline"; ids: string[] } | null>(null);
  const [note, setNote] = useState("");
  const baseOf = (ids: string[]) =>
    Object.fromEntries(ids.map((u) => [u, open.find((r) => r.u === u)?.rev ?? 0]));
  const session = useSession();
  const decide = async (
    decision: "approve" | "decline" | "reopen",
    ids: string[],
    why?: string,
    seen?: Record<string, number>,
  ) => {
    // the revs as the moderator saw them: an approve, the open request on
    // screen; an Undo, the request the decline left (`seen`), else the
    // declined request as the replica holds it
    const revOf = (u: string) =>
      decision === "reopen"
        ? (seen?.[u] ?? session?.reader().get("request", `${s.id}:${u}`)?.rev ?? 0)
        : (baseOf([u])[u] ?? 0);
    const base = Object.fromEntries(ids.map((u) => [u, revOf(u)]));
    const o = await write(
      "joinRequests.decide",
      {
        space: s.id,
        users: ids,
        decision,
        ...(decision === "decline" ? { why: why ?? "" } : { base }),
      },
      { quiet: true },
    );
    if (!o.ok && o.error) {
      const u = ids[0] ?? "";
      // STALE is not applied again: the toast has no action
      if (o.error.code === "STALE" && decision === "approve")
        toast(
          `Approve wasn’t applied because ${ids.length === 1 ? u : "someone"} changed the request after you chose Approve.`,
        );
      else refusalToast(o.error);
    }
    return o;
  };
  const n = open.filter((r) => sel.has(r.u)).length;
  const dialog = dlg ? (
    dlg.k === "approve" ? (
      <Modal
        title={
          dlg.ids.length === 1
            ? `Approve the request from ${dlg.ids[0]}?`
            : `Approve ${dlg.ids.length} requests?`
        }
        onClose={() => setDlg(null)}
        footer={
          <Foot>
            <button className="btn" type="button" onClick={() => setDlg(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                const ids = dlg.ids;
                setDlg(null);
                setSel(new Set());
                void decide("approve", ids).then((o) => {
                  if (o.ok)
                    toast(
                      ids.length === 1
                        ? `Approved ${ids[0]}. They can read ${spaceName(s)} now.`
                        : `Approved ${ids.length} requests.`,
                    );
                });
              }}
            >
              Approve
            </button>
          </Foot>
        }
      >
        <p className="muted">
          {dlg.ids.length === 1 ? `${dlg.ids[0]} becomes a member of` : "They become members of"} #
          {s.name}, can read its threads and gets a notification. This can't be undone; to reverse
          it, remove the member.
        </p>
      </Modal>
    ) : (
      <Modal
        title={
          dlg.ids.length === 1
            ? `Decline the request from ${dlg.ids[0]}?`
            : `Decline ${dlg.ids.length} requests?`
        }
        onClose={() => setDlg(null)}
        footer={
          <Foot>
            <button className="btn" type="button" onClick={() => setDlg(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              type="button"
              onClick={() => {
                const ids = dlg.ids;
                const why = note.trim();
                setDlg(null);
                setNote("");
                setSel(new Set());
                void decide("decline", ids, why).then((o) => {
                  if (!o.ok) return;
                  const one = ids[0];
                  // Undo reopens the request as this decline left it: a
                  // change someone made after it makes the Undo STALE
                  // (review round 2 of phase 2, finding 7)
                  const left = one
                    ? session?.reader().get("request", `${s.id}:${one}`)?.rev
                    : undefined;
                  if (ids.length === 1 && one)
                    toast(`Declined ${one}.`, {
                      label: "Undo",
                      run: () =>
                        void decide(
                          "reopen",
                          [one],
                          undefined,
                          left === undefined ? undefined : { [one]: left },
                        ),
                    });
                  else toast(`Declined ${ids.length} requests.`);
                });
              }}
            >
              Decline
            </button>
          </Foot>
        }
      >
        <p className="muted">
          {dlg.ids.length === 1 ? `${dlg.ids[0]} gets` : "Each applicant gets"} a notification that
          the request was declined{dlg.ids.length === 1 ? "" : ", with the same note"}. They can
          request again after 14 days.
        </p>
        <label className="fld">
          <span>
            Note to {dlg.ids.length === 1 ? dlg.ids[0] : "the applicants"}{" "}
            <small className="faint">optional</small>
          </span>
          <textarea
            id="cx-declnote"
            className="cs-ta"
            rows={2}
            placeholder="For example, what to include next time"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
        </label>
      </Modal>
    )
  ) : null;
  const decidedSec = decided.length ? (
    <section className="cs-sec rq-decided">
      <h3>Decided today</h3>
      {decided.map((r) => (
        <div className="rq-drow" key={r.u}>
          <Avatar u={r.u} className="sm" />
          <span className="rq-dtx">
            <b>{r.u}</b>{" "}
            <span className="faint">{r.st === "approved" ? "Approved" : "Declined"}</span>
          </span>
          {r.st === "declined" ? (
            <button className="tlink" type="button" onClick={() => void decide("reopen", [r.u])}>
              Undo
            </button>
          ) : null}
        </div>
      ))}
    </section>
  ) : null;
  if (!open.length)
    return (
      <>
        <div className="cs-empty">
          <p className="muted">
            No requests waiting. New requests appear here and in your notifications.
          </p>
        </div>
        {decidedSec}
        {dialog}
      </>
    );
  const toggle = (u: string) =>
    setSel((x) => {
      const y = new Set(x);
      if (y.has(u)) y.delete(u);
      else y.add(u);
      return y;
    });
  return (
    <>
      <div className="rq-bulk">
        <label className="cs-chk">
          <input
            type="checkbox"
            aria-label="Select all requests"
            checked={n > 0 && n === open.length}
            onChange={() => setSel(n === open.length ? new Set() : new Set(open.map((r) => r.u)))}
          />
          <span>{n ? `${n} selected` : "Select all"}</span>
        </label>
        <span className="grow" />
        {n ? (
          <>
            <button
              className="btn sm"
              type="button"
              onClick={() =>
                setDlg({ k: "decline", ids: open.filter((r) => sel.has(r.u)).map((r) => r.u) })
              }
            >
              Decline {n}
            </button>
            <button
              className="btn sm primary"
              type="button"
              onClick={() =>
                setDlg({ k: "approve", ids: open.filter((r) => sel.has(r.u)).map((r) => r.u) })
              }
            >
              Approve {n}
            </button>
          </>
        ) : (
          <span className="faint cs-small">{open.length} waiting · newest first</span>
        )}
      </div>
      <div className="rq-cards">
        {open.map((r) => (
          <article className={cx("rq-card", sel.has(r.u) && "sel")} key={r.u}>
            <div className="rq-ch">
              <input
                type="checkbox"
                className="rq-chk"
                aria-label={`Select ${r.u}`}
                checked={sel.has(r.u)}
                onChange={() => toggle(r.u)}
              />
              <div className="rq-who">
                <Avatar u={r.u} />
                <div className="rq-id">
                  <span className="rq-nm">
                    <Author u={r.u} />
                    <span className="faint">{r.u}</span>
                  </span>
                  <span className="faint rq-meta num">Requested {ago(r.createdAt, now)} ago</span>
                </div>
              </div>
            </div>
            {s.qs.map((q, k) =>
              r.a[k] ? (
                <div className="rq-a" key={k}>
                  <span className="rq-q">{q.q}</span>
                  <p>{r.a[k]}</p>
                </div>
              ) : null,
            )}
            <div className="rq-cf">
              <div className="rq-acts">
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => setDlg({ k: "decline", ids: [r.u] })}
                >
                  Decline
                </button>
                <button
                  className="btn sm primary"
                  type="button"
                  onClick={() => setDlg({ k: "approve", ids: [r.u] })}
                >
                  Approve
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {decidedSec}
      {dialog}
    </>
  );
}

// ---- reports ----

interface ItemInfo {
  noun: string;
  by: string;
  text: string;
  th: string;
  q: string;
  rev: number;
  mod: Moderated;
}

/** What a report is about: its noun, author, text and thread (keys as
 * reports.create names them: "a:<th>", "p:<th>", "f:<th>:<id>",
 * "r:<th>:<id>"). */
export function itemInfo(r: Reader, key: string): ItemInfo | null {
  const [k, th = "", sub] = key.split(":");
  const t = r.get("thread", th);
  if (!t) return null;
  const base = { th, q: t.q };
  if (k === "a")
    return {
      ...base,
      noun: "answer",
      by: "Agent",
      text: t.sum ?? "",
      rev: t.rev,
      mod: moderated(r, `thread:${th}`, t.mod),
    };
  if (k === "p")
    return {
      ...base,
      noun: "post",
      by: t.u,
      text: t.q,
      rev: t.rev,
      mod: moderated(r, `thread:${th}`, t.mod),
    };
  if (k === "f" && sub) {
    const f = r.get("followup", sub);
    return f
      ? {
          ...base,
          noun: "follow-up answer",
          by: "Agent",
          text: f.a ?? f.q,
          rev: f.rev,
          mod: moderated(r, `followup:${sub}`, f.mod),
        }
      : null;
  }
  if (k === "r" && sub) {
    const x = r.get("reply", sub);
    return x
      ? {
          ...base,
          noun: "reply",
          by: x.u,
          text: x.t,
          rev: x.rev,
          mod: moderated(r, `reply:${sub}`, x.mod),
        }
      : null;
  }
  return null;
}

/** A report's noun from its key alone (before its item is read). */
const NOUN: Record<string, string> = {
  a: "answer",
  p: "post",
  f: "follow-up answer",
  r: "reply",
};
const nounOf = (key: string) => NOUN[key.split(":")[0] ?? ""] ?? "item";

function Reports({ s }: { s: Space }) {
  const now = useNow();
  const [rm, setRm] = useState<{ id: string; by: string; noun: string; author: string } | null>(
    null,
  );
  const write = useWrite();
  const navigate = useNavigate();
  const data =
    useRecords(
      (r) =>
        r
          .list("report", (x) => x.sp === s.id)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((x) => {
            const it = itemInfo(r, x.key);
            return { rep: x, it, mod: it?.mod ?? null };
          }),
      [s.id],
    ) ?? [];
  const open = data.filter((x) => x.rep.st === "open");
  const done = data.filter((x) => x.rep.st !== "open" && now - Date.parse(x.rep.updatedAt) < 864e5);
  const me = useWorld().me?.u;
  // a reported item's thread may be held as a summary: read it in full
  const session = useSession();
  const threads = [...new Set(open.map((x) => x.rep.key.split(":")[1] ?? ""))].join(",");
  useEffect(() => {
    for (const th of threads.split(",")) if (th) void session?.openThread(s.id, th);
  }, [session, s.id, threads]);
  const resolve = async (id: string, how: "dismissed" | "hidden" | "removed", by: string) => {
    const o = await write("reports.resolve", { report: id, outcome: how });
    if (o.ok) {
      const who = by === me ? "You get" : `${by} gets`;
      toast(`${REP_DONE[how]?.[0] ?? how}. ${who} a notification that the report was resolved.`);
    }
  };
  const head = (
    <p className="cs-fine sf-rhead">
      <Svg src={SFI.flag} />
      <span>
        People report answers, follow-up answers, posts and replies from the item’s menu. Hiding
        keeps the item for moderators and shows a placeholder to everyone else; removing deletes it.
        The person who reported gets a notification when you resolve the report.
      </span>
    </p>
  );
  const decided = done.length ? (
    <section className="cs-sec rq-decided">
      <h3>Resolved today</h3>
      {done.map(({ rep, it }) => (
        <div className="rq-drow" key={rep.id}>
          <Avatar u={rep.by} className="sm" />
          <span className="rq-dtx">
            <b>{repWhy(rep.why)}</b>{" "}
            <span className="faint">
              · {it?.noun ?? nounOf(rep.key)} reported by {rep.by === me ? "you" : rep.by} ·{" "}
              {REP_DONE[rep.st]?.[0] ?? rep.st}
            </span>
          </span>
        </div>
      ))}
    </section>
  ) : null;
  if (!open.length)
    return (
      <>
        {head}
        <div className="cs-empty">
          <p className="muted">
            No open reports. New reports appear here and in your notifications.
          </p>
        </div>
        {decided}
      </>
    );
  return (
    <>
      {head}
      <div className="rq-cards sf-rcards">
        {open.map(({ rep, it, mod }) => (
          <article className="rq-card sf-rcard" key={rep.id}>
            <div className="sf-rc-h">
              <span className="sf-why">
                <Svg src={SFI.flag} />
                {repWhy(rep.why)}
              </span>
              <span className="faint cs-small">
                {it?.noun ?? nounOf(rep.key)} · reported {agoText(rep.createdAt, now)}
              </span>
            </div>
            {it ? (
              <div className="sf-rq">
                <span className="faint cs-small">
                  {it.by === "Agent" ? "Agent answer" : it.by} in{" "}
                  <button
                    className="tlink"
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: "/s/$space/t/$thread",
                        params: { space: s.name, thread: it.th },
                      })
                    }
                  >
                    {clip(it.q, 90)}
                  </button>
                </span>
                <p>{clip(plainText(it.text), 220)}</p>
                {mod ? (
                  <span className="ks bad">{mod === "hidden" ? "Hidden" : "Removed"}</span>
                ) : null}
              </div>
            ) : null}
            <div className="sf-rby">
              <Avatar u={rep.by} className="sm" />
              <span>
                <span className="faint">Reported by </span>
                <b>{rep.by === me ? "you" : rep.by}</b>
                {rep.note ? (
                  <span className="sf-rnote">“{rep.note}”</span>
                ) : (
                  <span className="faint"> · no note</span>
                )}
              </span>
            </div>
            <div className="rq-cf sf-racts">
              <button
                className="btn sm"
                type="button"
                onClick={() => void resolve(rep.id, "dismissed", rep.by)}
              >
                Dismiss
              </button>
              <button
                className="btn sm"
                type="button"
                onClick={() => void resolve(rep.id, "hidden", rep.by)}
              >
                Hide the {(it?.noun ?? nounOf(rep.key)).replace("follow-up ", "")}
              </button>
              <button
                className="btn sm sf-rm"
                type="button"
                onClick={() =>
                  setRm({
                    id: rep.id,
                    by: rep.by,
                    noun: it?.noun ?? nounOf(rep.key),
                    author: it?.by ?? "",
                  })
                }
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {decided}
      {rm ? (
        <Modal
          title={`Remove this ${rm.noun}?`}
          role="alertdialog"
          onClose={() => setRm(null)}
          footer={
            <Foot>
              <button className="btn" type="button" onClick={() => setRm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  setRm(null);
                  void resolve(rm.id, "removed", rm.by);
                }}
              >
                Remove
              </button>
            </Foot>
          }
        >
          <p className="muted">
            This deletes the {rm.noun} for everyone, including moderators. Its place in the thread
            shows “Removed by a moderator”. You can't undo after you leave this page.
          </p>
          <p className="cs-fine">
            <Svg src={CI.users} />
            <span>
              {rm.by === me ? "You get" : `${rm.by} gets`} a notification that the report was
              resolved. {rm.author === "Agent" ? "" : `${rm.author} does not see who reported it.`}
            </span>
          </p>
        </Modal>
      ) : null}
    </>
  );
}

// ---- members ----

function RoleSelect({ u, role, onPick }: { u: string; role: Role; onPick: (r: Role) => void }) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const cur = ROLES.find((r) => r[0] === role) ?? ROLES[0];
  return (
    <span className="mem-dd">
      <span className="sr-only" id={`dl-role-${u}`}>
        Role of {u}
      </span>
      <div className={cx("dd", open && "open")}>
        <button
          type="button"
          className="dd-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={`dl-role-${u} dd-v-role-${u}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span id={`dd-v-role-${u}`}>{cur?.[1]}</span>
          <Svg src={I.chev} />
        </button>
        {open ? (
          <>
            <Scrim onClose={() => setOpen(false)} />
            <div className="dd-pop" role="listbox" aria-labelledby={`dl-role-${u}`}>
              {ROLES.map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  className="dd-o"
                  role="option"
                  aria-selected={v === role}
                  onClick={() => {
                    setOpen(false);
                    if (v !== role) onPick(v);
                  }}
                >
                  <span>{l}</span>
                  {v === role ? <Svg src={I.check} /> : null}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </span>
  );
}

function Members({ s, myRole }: { s: Space; myRole: Role }) {
  const now = useNow();
  const write = useWrite();
  const me = useWorld().me?.u ?? "";
  const [q, setQ] = useState("");
  const [dlg, setDlg] = useState<
    { k: "role"; u: string; to: Role } | { k: "remove" | "ban" | "owner"; u: string } | null
  >(null);
  const members =
    useRecords((r) => r.list("member", (m) => m.sp === s.id), [s.id])?.sort(
      (a, b) => RANK[b.role]! - RANK[a.role]! || (a.joinedAt < b.joinedAt ? -1 : 1),
    ) ?? [];
  const bans = useRecords((r) => r.list("ban", (b) => b.sp === s.id), [s.id]) ?? [];
  const canRole = myRole === "owner" || myRole === "admin";
  const shown = q.trim() ? members.filter((m) => m.u.includes(q.trim().toLowerCase())) : members;
  const canAct = (m: { u: string; role: Role }) =>
    m.u !== me &&
    m.role !== "owner" &&
    (m.role === "admin" ? RANK[myRole]! >= RANK["admin"]! : RANK[myRole]! > RANK[m.role]!);
  const L = (r: Role) => ROLES.find((x) => x[0] === r)?.[1] ?? "Owner";
  const dialog = !dlg ? null : dlg.k === "owner" ? (
    <Modal
      title={`Make ${dlg.u} the owner of ${spaceName(s)}?`}
      role="alertdialog"
      onClose={() => setDlg(null)}
      footer={
        <Foot>
          <button className="btn" type="button" onClick={() => setDlg(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              const u = dlg.u;
              const m = members.find((x) => x.u === u);
              setDlg(null);
              void write("members.setRole", {
                space: s.id,
                user: u,
                role: "owner",
                base: { rev: m?.rev ?? 0 },
              }).then((o) => {
                if (o.ok) toast(`${u} is now the owner of ${spaceName(s)}.`);
              });
            }}
          >
            Make owner
          </button>
        </Foot>
      }
    >
      <p className="muted">
        {dlg.u} becomes the owner: they can transfer ownership, and archive or delete {spaceName(s)}
        . You become an admin and can still change roles and settings.
      </p>
      <p className="cs-fine">
        <Svg src={MI.mods} />
        <span>A space has one owner. Only {dlg.u} can make you the owner again.</span>
      </p>
    </Modal>
  ) : dlg.k === "role" ? (
    (() => {
      const m = members.find((x) => x.u === dlg.u);
      const was = m?.role ?? "member";
      const up = RANK[dlg.to]! > RANK[was]!;
      const what = up
        ? `${dlg.u} will be able to ${CAN[dlg.to]}.`
        : dlg.to === "member"
          ? `${dlg.u} will no longer be able to ${CAN[was]}.`
          : `${dlg.u} will no longer be able to change roles or settings, but can still ${CAN["mod"]}.`;
      return (
        <Modal
          title={`Change ${dlg.u} from ${L(was)} to ${L(dlg.to)}?`}
          role="alertdialog"
          onClose={() => setDlg(null)}
          footer={
            <Foot>
              <button className="btn" type="button" onClick={() => setDlg(null)}>
                Cancel
              </button>
              <button
                className={cx("btn", up ? "primary" : "danger")}
                type="button"
                onClick={() => {
                  const { u, to } = dlg;
                  setDlg(null);
                  void write("members.setRole", {
                    space: s.id,
                    user: u,
                    role: to,
                    base: { rev: m?.rev ?? 0 },
                  }).then((o) => {
                    if (o.ok)
                      toast(
                        `${u} is now ${to === "admin" ? "an admin" : `a ${L(to).toLowerCase()}`}.`,
                      );
                  });
                }}
              >
                {up ? `Make ${L(dlg.to).toLowerCase()}` : "Change role"}
              </button>
            </Foot>
          }
        >
          <p className="muted">{what}</p>
          <p className="cs-fine">
            <Svg src={MI.mods} />
            <span>
              Moderators can approve requests and remove members. Admins can also change roles and
              settings.
            </span>
          </p>
        </Modal>
      );
    })()
  ) : (
    <Modal
      title={
        dlg.k === "ban"
          ? `Ban ${dlg.u} from ${spaceName(s)}?`
          : `Remove ${dlg.u} from ${spaceName(s)}?`
      }
      role="alertdialog"
      onClose={() => setDlg(null)}
      footer={
        <Foot>
          <button className="btn" type="button" onClick={() => setDlg(null)}>
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            onClick={() => {
              const { u, k } = dlg;
              const m = members.find((x) => x.u === u);
              setDlg(null);
              void write(
                k === "ban" ? "members.ban" : "members.remove",
                k === "ban"
                  ? { space: s.id, user: u }
                  : { space: s.id, user: u, base: { adm: m?.adm ?? "" } },
              ).then((o) => {
                if (o.ok) toast(k === "ban" ? `Banned ${u}.` : `Removed ${u}.`);
              });
            }}
          >
            {dlg.k === "ban" ? "Ban" : "Remove"}
          </button>
        </Foot>
      }
    >
      <p className="muted">
        {dlg.k === "ban"
          ? "The user will lose access now and cannot request to join or use invite links. Their threads and asks will remain in the space."
          : `The user will lose access now. They can request to join again${s.policy === "invite" ? " if someone invites them" : ""}.`}
      </p>
      <p className="cs-fine">
        <Svg src={I.agent} />
        <span>The user will not be notified.</span>
      </p>
    </Modal>
  );
  return (
    <>
      <div className="mem-top">
        <label className="search cs-sq">
          <Svg src={I.search} />
          <input
            id="cs-memq"
            type="search"
            placeholder="Find a member"
            aria-label="Find a member"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
        </label>
        <span className="faint cs-small num">
          Showing {shown.length} of {fmt(s.members)}
        </span>
      </div>
      <div className="mem-list">
        {shown.map((m) => {
          const mine = m.u === me;
          return (
            <div className="mem-row" key={m.u} data-mname={m.u}>
              <Avatar u={m.u} />
              <div className="mem-tx">
                <Author u={m.u} />
                <small className="faint">
                  {m.u} · joined {dayOf(m.joinedAt, now).split(" ")[0]}{" "}
                  {new Date(m.joinedAt).getUTCFullYear()}
                </small>
              </div>
              {m.role === "owner" ? (
                <span className="mem-role">Owner</span>
              ) : mine || !canRole ? (
                <span className="mem-role">
                  {L(m.role)}
                  {mine ? " (you)" : ""}
                </span>
              ) : (
                <RoleSelect
                  u={m.u}
                  role={m.role}
                  onPick={(to) => setDlg({ k: "role", u: m.u, to })}
                />
              )}
              <span className="mem-acts">
                {myRole === "owner" && m.role === "admin" ? (
                  <button
                    className="tlink"
                    type="button"
                    onClick={() => setDlg({ k: "owner", u: m.u })}
                  >
                    Make owner
                  </button>
                ) : null}
                {canAct(m) ? (
                  <>
                    <button
                      className="tlink"
                      type="button"
                      onClick={() => setDlg({ k: "remove", u: m.u })}
                    >
                      Remove
                    </button>
                    <button
                      className="tlink danger-l"
                      type="button"
                      onClick={() => setDlg({ k: "ban", u: m.u })}
                    >
                      Ban
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <p className="cs-fine">
        <Svg src={MI.mods} />
        <span>
          Moderators can approve requests and remove or ban members. Admins can also remove or ban
          moderators and admins, and change roles and settings. Only the owner can transfer
          ownership. {canRole ? "" : "Only admins can change roles."}
        </span>
      </p>
      {bans.length ? (
        <section className="cs-sec">
          <h3>Banned</h3>
          <p className="muted cs-small">
            Banned people cannot request to join or use invite links. Their threads and asks will
            remain in the space.
          </p>
          {bans.map((b) => (
            <div className="mem-row" key={b.u}>
              <Avatar u={b.u} className="sm" />
              <div className="mem-tx">
                <b>{b.u}</b>
                <small className="faint">
                  Banned {now - Date.parse(b.createdAt) < 864e5 ? "today" : dayOf(b.createdAt, now)}
                </small>
              </div>
              <button
                className="tlink"
                type="button"
                onClick={() =>
                  void write("members.unban", { space: s.id, user: b.u }).then((o) => {
                    if (o.ok) toast(`Unbanned ${b.u}. They can request to join again.`);
                  })
                }
              >
                Unban
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {dialog}
    </>
  );
}

// ---- invites ----

const EXPIRY: [string, string][] = [
  ["1", "After 1 day"],
  ["7", "After 7 days"],
  ["30", "After 30 days"],
  ["0", "Never"],
];

function Invites({ s }: { s: Space }) {
  const now = useNow();
  const write = useWrite();
  const session = useSession();
  const [exp, setExp] = useState("7");
  const [ddOpen, setDdOpen] = useState(false);
  useOverlay(ddOpen, () => setDdOpen(false));
  const links =
    useRecords((r) => r.list("invite", (l) => l.sp === s.id && l.revokedAt === null), [s.id])?.sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : -1),
    ) ?? [];
  const meta = (l: (typeof links)[number]) =>
    l.dead
      ? l.dead === "Used"
        ? `Used by ${l.usedBy ?? ""}`
        : `Expired ${l.expiresAt ? dayOf(l.expiresAt, now) : ""}`
      : `One use · ${l.expiresAt ? `expires ${dayOf(l.expiresAt, now)}` : "no expiry"}`;
  const url = (code: string) => `${location.host}/i/${code}`;
  const create = async () => {
    const days = Number(exp);
    const o = await write("invites.create", {
      id: session?.newId() ?? "",
      space: s.id,
      days: days || null,
    });
    if (o.ok) {
      const code = (o.result as { code?: string } | null)?.code;
      if (code) toast(`Link created: ${url(code)}`);
    }
  };
  const cur = EXPIRY.find((e) => e[0] === exp) ?? EXPIRY[1];
  return (
    <section className="cs-sec">
      <h3>Invite links</h3>
      <p className="muted cs-small">
        Each link works once: the first person who opens it joins without a request
        {s.vis === "unlisted" ? ". Links are the only way to find this unlisted space" : ""}.
      </p>
      <div className="cs-linkmk">
        <div className="fld">
          <span id="dl-lexp">Expires</span>
          <div className={cx("dd", ddOpen && "open")}>
            <button
              type="button"
              className="dd-btn"
              aria-haspopup="listbox"
              aria-expanded={ddOpen}
              aria-labelledby="dl-lexp dd-v-lexp"
              onClick={() => setDdOpen((o) => !o)}
            >
              <span id="dd-v-lexp">{cur?.[1]}</span>
              <Svg src={I.chev} />
            </button>
            {ddOpen ? (
              <>
                <Scrim onClose={() => setDdOpen(false)} />
                <div className="dd-pop" role="listbox" aria-labelledby="dl-lexp">
                  {EXPIRY.map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      className="dd-o"
                      role="option"
                      aria-selected={v === exp}
                      onClick={() => {
                        setExp(v);
                        setDdOpen(false);
                      }}
                    >
                      <span>{l}</span>
                      {v === exp ? <Svg src={I.check} /> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
        <button className="btn primary" type="button" onClick={() => void create()}>
          Create link
        </button>
      </div>
      <div className="ak-list">
        {links.length ? (
          links.map((l) => (
            <div className={cx("ak-row", l.dead && "bad")} key={l.id}>
              <span className="ts-ic">
                <Svg src={CI.link} />
              </span>
              <div className="ak-tx">
                <b>{l.code ? url(l.code) : "Creating…"}</b>
                <small>
                  Created by {l.by} · {meta(l)}
                </small>
              </div>
              {l.dead ? (
                <span className="ks bad">Inactive</span>
              ) : (
                <>
                  <button
                    className="btn sm"
                    type="button"
                    disabled={!l.code}
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(`${location.origin}/i/${l.code}`)
                        .catch(() => undefined);
                      toast(`Copied ${url(l.code)}`);
                    }}
                  >
                    Copy
                  </button>
                  <button
                    className="btn sm"
                    type="button"
                    onClick={() =>
                      void write("invites.revoke", { id: l.id }).then((o) => {
                        if (o.ok)
                          toast("Link revoked. People who already joined with it stay members.", {
                            label: "Undo",
                            run: () => void write("invites.restore", { id: l.id }),
                          });
                      })
                    }
                  >
                    Revoke
                  </button>
                </>
              )}
            </div>
          ))
        ) : (
          <div className="ak-row">
            <span className="muted">No links yet.</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- the page ----

export function ManagePage({ name, tab }: { name: string; tab: string }) {
  const w = useWorld();
  const navigate = useNavigate();
  const s = useMemo(() => w.spaces.find((x) => x.name === name), [w.spaces, name]);
  const role = s ? w.roles[s.id] : undefined;
  const counts = useRecords(
    (r) =>
      s
        ? {
            req: r.list("request", (q) => q.sp === s.id && q.st === "open").length,
            rep: r.list("report", (q) => q.sp === s.id && q.st === "open").length,
          }
        : { req: 0, rep: 0 },
    [s?.id],
  ) ?? { req: 0, rep: 0 };
  if (!s || !isStaff(role) || !role) {
    if (!w.loaded) return <Page place={{ kind: "other" }}>{null}</Page>;
    return (
      <Page place={{ kind: "other" }}>
        <NotFound space={s ? undefined : name} />
      </Page>
    );
  }
  const closed = isClosed(s);
  const tabs: [ManageTab, React.ReactNode][] = [
    ...(closed && (s.policy === "request" || counts.req)
      ? ([
          [
            "requests",
            <>
              Requests
              {counts.req ? (
                <>
                  {" "}
                  <span className="cs-n num">{counts.req}</span>
                </>
              ) : null}
            </>,
          ],
        ] as [ManageTab, React.ReactNode][])
      : []),
    [
      "reports",
      <>
        Reports
        {counts.rep ? (
          <>
            {" "}
            <span className="cs-n num">{counts.rep}</span>
          </>
        ) : null}
      </>,
    ],
    [
      "members",
      <>
        Members <span className="faint num">{fmt(s.members)}</span>
      </>,
    ],
    ...(closed ? ([["invites", "Invites"]] as [ManageTab, React.ReactNode][]) : []),
    ["skills", "Skills"],
    ["sources", "Sources"],
    ...(role === "owner" || role === "admin"
      ? ([["settings", "Settings"]] as [ManageTab, React.ReactNode][])
      : []),
  ];
  const cur = (tabs.find((t) => t[0] === tab) ?? tabs[0])?.[0] ?? "members";
  const go = (t: ManageTab) =>
    void navigate({
      to: "/s/$space/manage/$tab",
      params: { space: s.name, tab: t },
      replace: true,
    });
  return (
    <Page place={{ kind: "space", id: s.id }}>
      <div className={`home-wide sub-page cs-mg cs-mg-${cur}`}>
        <div className="sub-top">
          <div className="ys-et">
            <button
              className="th-back"
              type="button"
              onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
            >
              <Svg src={I.chev} className="bk" />
              {spaceName(s)}
            </button>
            <h2>Manage</h2>
          </div>
          {closed ? (
            <span className="cs-vis cs-vis-top">
              <Svg src={s.vis === "unlisted" ? CI.eyeOff : SVG.LOCK} />
              {visLabel(s)}
            </span>
          ) : null}
        </div>
        <div className="pf-tabs cs-mtabs" role="tablist">
          {tabs.map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={cur === k}
              onClick={() => go(k)}
            >
              {l}
            </button>
          ))}
        </div>
        {cur === "requests" ? (
          <Requests s={s} />
        ) : cur === "reports" ? (
          <Reports s={s} />
        ) : cur === "members" ? (
          <Members s={s} myRole={role} />
        ) : cur === "skills" ? (
          <SkillsManage s={s} />
        ) : cur === "sources" ? (
          <SourcesManage s={s} />
        ) : cur === "settings" ? (
          <SettingsManage s={s} />
        ) : (
          <Invites s={s} />
        )}
      </div>
    </Page>
  );
}
