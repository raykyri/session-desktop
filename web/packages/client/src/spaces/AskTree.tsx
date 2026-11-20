// An ask tree's organizing tools (phase 2b, slice 3; the mockup's qt-*):
// the map (every ask as a box by level, the path to the selected one
// marked), compare two branches (`/a/<a>/compare/<a>,<b>`: the asks from
// where they part, side by side, and an ask about both, research.forkNode
// with `uses`), start a thread from a branch (threads.create with `from`),
// and the ask's menu that leads to them.

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ago, spaceName } from "../data/format.js";
import { isStaff, type FollowUp, type Space, type ThreadView } from "../data/spaces.js";
import { Markdown } from "../features/markdown/index.js";
import { siteOrigin } from "../platform.js";
import { useNow } from "../sync/react.js";

import { DeleteDialog, ReportDialog, type Item } from "./ItemMenu.js";
import { Modal } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Avatar } from "./atoms.js";
import { cx } from "./cx.js";
import { NVI, QTI, SFI } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { WRITE_ERROR, lostEditsToast, toast, useCreate, useQuickWrite } from "./writes.js";

const clip = (t: string, n: number) =>
  t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t;

/** The ask's level (1 for a follow-up of the thread's ask) and its path. */
export function pathOf(t: ThreadView, id: string): FollowUp[] {
  const out: FollowUp[] = [];
  for (
    let cur = t.followups.find((f) => f.id === id);
    cur;
    cur = t.followups.find((f) => f.id === cur?.par)
  )
    out.unshift(cur);
  return out;
}

// ---- the map ----

const W = 230;
const H = 56;
const GX = 12;
const GY = 10;

export function MapDialog({
  t,
  sel,
  path,
  go,
  onClose,
}: {
  t: ThreadView;
  sel: string;
  path: Set<string>;
  go: (n: string) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(0.8);
  // a tidy tree: leaves one under another, a parent at its children's middle
  const pos = new Map<string, { x: number; y: number }>();
  let row = 0;
  const place = (id: string, depth: number): number => {
    const kids = t.followups.filter((f) => (id === "r" ? f.par === null : f.par === id));
    let y: number;
    if (!kids.length) y = row++ * (H + GY);
    else {
      const ys = kids.map((k) => place(k.id, depth + 1));
      y = ((ys[0] ?? 0) + (ys[ys.length - 1] ?? 0)) / 2;
    }
    pos.set(id, { x: depth * (W + GX * 2) + GX, y: y + GY });
    return y;
  };
  place("r", 0);
  const levels = Math.max(0, ...t.followups.map((f) => pathOf(t, f.id).length));
  const width = (levels + 1) * (W + GX * 2) + GX;
  const height = row * (H + GY) + GY * 2;
  const box = (id: string, title: string, u: string, meta: string) => {
    const p = pos.get(id) ?? { x: 0, y: 0 };
    const on = id === "r" || path.has(id);
    return (
      <button
        key={id}
        className={cx("qt-mn", on && "path")}
        type="button"
        aria-current={sel === id}
        style={{ left: p.x, top: p.y }}
        title={title}
        onClick={() => {
          onClose();
          go(id);
        }}
      >
        <span className="qt-mn-t">{clip(title, 90)}</span>
        <span className="qt-mn-m">
          <Avatar u={u} />
          <span>
            {meta} · {u}
          </span>
        </span>
      </button>
    );
  };
  return (
    <Modal
      title={
        <>
          Map of this thread{" "}
          <span className="num faint">
            {t.followups.length + 1} {t.followups.length ? "asks" : "ask"} · {levels}{" "}
            {levels === 1 ? "level" : "levels"}
          </span>
        </>
      }
      className="qt-mapdlg"
      onClose={onClose}
    >
      <div className="qt-maptool">
        <span className="seg" role="group" aria-label="Zoom">
          {[0.6, 0.8, 1].map((z) => (
            <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {Math.round(z * 100)}%
            </button>
          ))}
        </span>
        <span className="grow" />
        <span>
          <i className="qt-pathdot" /> Path to the ask you are on
        </span>
      </div>
      <div className="qt-map" id="qt-map">
        <div className="qt-mapc" style={{ width: width * zoom, height: height * zoom }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              width,
              height,
              transform: `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              width={width}
              height={height}
              aria-hidden="true"
              style={{ position: "absolute", inset: 0 }}
            >
              {t.followups.map((f) => {
                const a = pos.get(f.par ?? "r");
                const b = pos.get(f.id);
                if (!a || !b) return null;
                return (
                  <path
                    key={f.id}
                    d={`M${a.x + W} ${a.y + H / 2} C${a.x + W + GX} ${a.y + H / 2} ${b.x - GX} ${b.y + H / 2} ${b.x} ${b.y + H / 2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.35}
                  />
                );
              })}
            </svg>
            {box("r", t.t ?? t.q, t.u, "Question")}
            {t.followups.map((f) => box(f.id, f.q, f.u, `L${pathOf(t, f.id).length}`))}
          </div>
        </div>
      </div>
      <p className="qt-note qt-maphint">Select an ask to open it.</p>
    </Modal>
  );
}

// ---- compare two branches ----

export function Compare({
  t,
  space,
  a,
  b,
  go,
  close,
}: {
  t: ThreadView;
  space: Space;
  a: string;
  b: string;
  go: (n: string) => void;
  close: () => void;
}) {
  const now = useNow();
  const create = useCreate();
  const [side, setSide] = useState<"a" | "b">("a");
  const [q, setQ] = useState("");
  const pa = pathOf(t, a);
  const pb = pathOf(t, b);
  let k = 0;
  while (k < pa.length && k < pb.length && pa[k]?.id === pb[k]?.id) k++;
  const base = k ? pa[k - 1] : null;
  const col = (steps: FollowUp[], name: "a" | "b") => (
    <div className={cx("qt-cmp-col", name)}>
      <h3>
        Branch {name.toUpperCase()}{" "}
        <span className="num">
          {steps.length} {steps.length === 1 ? "ask" : "asks"}
        </span>
      </h3>
      {steps.map((f) => (
        <div className="qt-cmp-step" key={f.id}>
          <div className="qt-ancm">
            <span className="qt-lv num" title={`Level ${pathOf(t, f.id).length}`}>
              {pathOf(t, f.id).length}
            </span>
            <Avatar u={f.u} className="sm" />
            <span>
              {f.u} · {ago(f.createdAt, now)}
            </span>
          </div>
          <button className="qt-ancq" type="button" onClick={() => go(f.id)}>
            {f.q}
          </button>
          {f.a ? <Markdown markdown={f.a} className="prose" /> : null}
        </div>
      ))}
    </div>
  );
  const ask = async () => {
    if (!q.trim() || create.checking) return;
    const o = await create.send("research.forkNode", (id) => ({
      id,
      thread: t.id,
      parent: side === "a" ? a : b,
      q: q.trim(),
      uses: [a, b],
      pay: "session",
    }));
    if (o.ok) {
      setQ("");
      go(o.id);
      if (o.lostEdits) lostEditsToast("follow-up", q.trim());
    } else if (o.error === null) toast(WRITE_ERROR["unavailable"] ?? "");
  };
  return (
    <div className="qt-cmp">
      <div className="qt-cmp-h">
        <h2>Compare two branches</h2>
        <span className="grow" />
        <span className="seg qt-cmp-seg" role="group" aria-label="Branch shown">
          <button type="button" aria-pressed={side === "a"} onClick={() => setSide("a")}>
            Branch A
          </button>
          <button type="button" aria-pressed={side === "b"} onClick={() => setSide("b")}>
            Branch B
          </button>
        </span>
        <button className="btn" type="button" onClick={close}>
          Close
        </button>
      </div>
      <div className="qt-cmp-base">
        <small>
          {base ? `Both branches start from level ${k}` : "Both branches start from the question"}
        </small>
        <button className="qt-ancq" type="button" onClick={() => go(base?.id ?? "r")}>
          {base?.q ?? t.q}
        </button>
      </div>
      <div className="qt-cmp-cols" data-side={side}>
        {col(pa.slice(k), "a")}
        {col(pb.slice(k), "b")}
      </div>
      <div className="qt-comp">
        <textarea
          id="qt-in"
          rows={2}
          placeholder="Ask about both branches…"
          aria-label="Ask about both branches"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        <p className="qt-note">
          The agent gets both branches. The ask goes under branch {side.toUpperCase()} in{" "}
          {spaceName(space)}.
        </p>
        <div className="qt-cbar fu2-bar">
          <span className="grow" />
          <button
            className="btn primary"
            type="button"
            disabled={!q.trim()}
            onClick={() => void ask()}
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- start a thread from a branch ----

function PromoteDialog({
  t,
  f,
  space,
  onClose,
}: {
  t: ThreadView;
  f: FollowUp;
  space: Space;
  onClose: () => void;
}) {
  const create = useCreate();
  const navigate = useNavigate();
  const sub = t.followups.filter(
    (x) => pathOf(t, x.id).some((y) => y.id === f.id) && x.id !== f.id,
  ).length;
  const [title, setTitle] = useState(f.q.replace(/\?$/, ""));
  const [inc, setInc] = useState<"all" | "one">(sub ? "all" : "one");
  const start = async () => {
    if (create.checking) return;
    const o = await create.send("threads.create", (id) => ({
      id,
      space: space.id,
      kind: "ask",
      q: f.q,
      title: title.trim() || f.q,
      from: { th: t.id, node: f.id },
      branch: inc,
    }));
    if (!o.ok) {
      if (o.error === null) toast(WRITE_ERROR["unavailable"] ?? "");
      return;
    }
    onClose();
    if (o.lostEdits) lostEditsToast("thread", title.trim() || f.q);
    else toast(`Thread started in ${spaceName(space)}. The branch it came from links to it.`);
    void navigate({ to: "/s/$space/t/$thread", params: { space: space.name, thread: o.id } });
  };
  return (
    <Modal
      title="Start a thread from this branch"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={() => void start()}>
            Start thread
          </button>
        </>
      }
    >
      <div className="qt-form">
        <p className="muted">
          The new thread starts with this ask and its answer, copied without a new research run. The
          branch stays in this thread, with a link to the new one.
        </p>
        <label className="qt-fl">
          Title, used in lists and notifications
          <input
            type="text"
            id="qt-pro-t"
            value={title}
            autoComplete="off"
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        {sub ? (
          <div className="qt-fl">
            <span>Include</span>
            <div className="qt-radio" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={inc === "all"}
                onClick={() => setInc("all")}
              >
                <i />
                <span>
                  This ask and the {sub} below it
                  <small>This copies them into the new thread and notifies their askers.</small>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={inc === "one"}
                onClick={() => setInc("one")}
              >
                <i />
                <span>
                  This ask only<small>The asks below it stay only in this thread.</small>
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// ---- the ask's menu ----

export function AskMenu({
  t,
  f,
  space,
  onCompare,
}: {
  t: ThreadView;
  f: FollowUp;
  space: Space;
  onCompare: () => void;
}) {
  const w = useWorld();
  const quick = useQuickWrite();
  const [open, setOpen] = useState(false);
  const [dlg, setDlg] = useState<"promote" | "report" | "delete" | null>(null);
  useOverlay(open, () => setOpen(false));
  const mine = w.me?.u === f.u && !f.del;
  // the asker of the branch, the thread's owner and the space's moderators
  // (2b design finding 4: the mockup's qtCanPromote, the server agent's rule)
  const canPromote = !!w.me && (mine || w.me.u === t.u || isStaff(w.roles[space.id]));
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item: Item = {
    key: `f:${t.id}:${f.id}`,
    noun: "follow-up answer",
    by: "Agent",
    text: f.a ?? f.q,
    q: t.q,
    mod: f.mod,
    own: mine,
    kids: t.followups.filter((x) => x.par === f.id).length,
    url: `${siteOrigin()}/s/${space.name}/t/${t.id}/a/${f.id}`,
  };
  const it = (icon: string, label: string, run: () => void, sub?: string, disabled = false) => (
    <button
      className="um-item"
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : pick(run)}
    >
      <Svg src={icon} />
      <span>
        {label}
        {sub ? <small>{sub}</small> : null}
      </span>
    </button>
  );
  return (
    <span className="qt-mw">
      <button
        className="act sf-im"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="More actions for this ask"
        title="More"
        onClick={() => setOpen((o) => !o)}
      >
        <Svg src={SFI.more} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop cs-pop qt-pop" role="menu">
            {it(QTI.link, "Copy link to this ask", () => {
              void navigator.clipboard?.writeText(item.url).catch(() => undefined);
              toast("Link copied.");
            })}
            {it(
              f.saved ? QTI.saved : QTI.save,
              f.saved ? "Remove from Saved" : "Save this ask",
              () => quick("saved.set", { kind: "ask", id: `${t.id}:${f.id}`, on: !f.saved }),
            )}
            {it(QTI.cmp, "Compare with another ask", onCompare)}
            {it(
              QTI.out,
              "Start a thread from this branch",
              () => setDlg("promote"),
              canPromote
                ? undefined
                : "Only the asker of this branch, the thread owner and moderators can do this.",
              !canPromote,
            )}
            {mine
              ? it(NVI.trash, "Delete", () => setDlg("delete"))
              : w.me
                ? it(SFI.flag, "Report a problem", () => setDlg("report"))
                : null}
          </div>
        </>
      ) : null}
      {dlg === "promote" ? (
        <PromoteDialog t={t} f={f} space={space} onClose={() => setDlg(null)} />
      ) : null}
      {dlg === "report" ? (
        <ReportDialog item={item} space={space} onClose={() => setDlg(null)} />
      ) : null}
      {dlg === "delete" ? <DeleteDialog item={item} onClose={() => setDlg(null)} /> : null}
    </span>
  );
}
