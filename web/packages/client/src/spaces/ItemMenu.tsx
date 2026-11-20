// An item's "More" menu (the mockup's itemMenu) on an answer, a post, a
// follow-up or a reply: Report a problem (someone else's), Copy link, Delete
// (your own), and for the space's staff Hide and Remove. Item keys are the
// ones reports.create and moderation.decide take: "a:<th>", "p:<th>",
// "f:<th>:<id>", "r:<th>:<id>".

import { useState } from "react";

import { spaceName } from "../data/format.js";
import { isStaff, type Moderated, type Space } from "../data/spaces.js";
import { useRecords, useSession } from "../sync/react.js";

import { REP_WHY } from "./Manage.js";
import { Modal } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { CI, I, SFI } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { refusalToast, savedToast, toast, useWrite } from "./writes.js";

const TRASH =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';

const REP_PH: Record<string, string> = {
  incorrect: "What is wrong, and what is correct? A link helps.",
  old: "What changed, and since when?",
  offensive: "Anything the moderators should know",
  other: "Describe the problem",
};

const clip = (t: string, n = 150) =>
  t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t;

export interface Item {
  key: string;
  noun: "answer" | "post" | "follow-up answer" | "reply" | "ask" | "follow-up";
  /** Its author ("Agent" for an answer). */
  by: string;
  text: string;
  /** The thread's question, for the report's context line. */
  q: string;
  mod: Moderated;
  /** Your own item: Delete in place of Report. */
  own: boolean;
  /** How many items below it stay when it is deleted. */
  kids: number;
  url: string;
}

export function ReportDialog({
  item,
  space,
  onClose,
}: {
  item: Item;
  space: Space;
  onClose: () => void;
}) {
  const write = useWrite();
  const session = useSession();
  const [why, setWhy] = useState("incorrect");
  const [note, setNote] = useState("");
  const send = async () => {
    onClose();
    const o = await write("reports.create", {
      id: session?.newId() ?? "",
      item: item.key,
      why,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    savedToast(
      o,
      `Report sent to the moderators of ${spaceName(space)}. You get a notification when they resolve it.`,
    );
  };
  const ctx =
    item.by === "Agent"
      ? `Agent ${item.noun}`
      : `${item.noun[0]?.toUpperCase() ?? ""}${item.noun.slice(1)} by ${item.by}`;
  return (
    <Modal
      title={`Report this ${item.noun}`}
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
      <div className="sf-rep-ctx">
        <span className="faint cs-small">
          {ctx}
          {item.key.startsWith("p:") ? "" : ` in “${clip(item.q, 80)}”`}
        </span>
        <p>{clip(item.text)}</p>
      </div>
      <div className="ts-list cs-opts" role="radiogroup" aria-label="Reason">
        {REP_WHY.map(([k, l, d]) => (
          <button
            key={k}
            type="button"
            className="ts-row cs-opt"
            role="radio"
            aria-checked={why === k}
            onClick={() => setWhy(k)}
          >
            <span className="cs-radio" />
            <span className="ts-tx">
              <b>{l}</b>
              <small>{d}</small>
            </span>
          </button>
        ))}
      </div>
      <label className="fld">
        <span>
          Note <small className="faint">optional</small>
        </span>
        <textarea
          id="sf-repnote"
          className="cs-ta"
          rows={3}
          placeholder={REP_PH[why]}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
      </label>
      <p className="cs-fine">
        <Svg src={CI.users} />
        <span>
          The moderators of {spaceName(space)} see your report, your note and your handle. The{" "}
          {item.noun} stays visible while they review it. You get a notification when they resolve
          it.
        </span>
      </p>
    </Modal>
  );
}

function RemoveDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const write = useWrite();
  const remove = async () => {
    onClose();
    const o = await write("moderation.decide", { item: item.key, decision: "removed" });
    if (o.ok) toast(`Removed. The thread shows “This ${item.noun} was removed by a moderator.”`);
  };
  return (
    <Modal
      title={`Remove this ${item.noun}?`}
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" type="button" onClick={() => void remove()}>
            Remove
          </button>
        </>
      }
    >
      <p className="muted">
        This deletes the {item.noun} for everyone, including moderators. Its place in the thread
        shows “This {item.noun} was removed by a moderator.” You can't undo after you leave this
        page.
      </p>
      {item.by === "Agent" ? null : (
        <p className="cs-fine">
          <Svg src={CI.users} />
          <span>{item.by} is not notified.</span>
        </p>
      )}
    </Modal>
  );
}

export function DeleteDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const write = useWrite();
  const n = item.kids;
  const noun =
    item.noun === "follow-up answer" ? "follow-up" : item.noun === "answer" ? "ask" : item.noun;
  const rest: Record<string, string> = {
    post: n === 1 ? "The reply stays" : `The ${n} replies stay`,
    ask: `The answer and ${n === 1 ? "the follow-up" : `the ${n} follow-ups`} stay`,
    reply: n === 1 ? "The reply to it stays" : `The ${n} replies to it stay`,
    "follow-up": n === 1 ? "The ask below it stays" : `The ${n} asks below it stay`,
  };
  const gone: Record<string, string> = {
    post: "This removes the post for everyone.",
    ask: "This removes the ask and its answer for everyone.",
    reply: "This removes the reply for everyone.",
    "follow-up": "This removes the follow-up and its answer for everyone.",
  };
  const del = async () => {
    onClose();
    const [k, th = "", sub = ""] = item.key.split(":");
    if (k === "a" || k === "p") await write("threads.delete", { id: th });
    else if (k === "f") await write("followups.delete", { thread: th, node: sub });
    else await write("replies.delete", { thread: th, reply: sub });
  };
  return (
    <Modal
      title={`Delete your ${noun}?`}
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" type="button" onClick={() => void del()}>
            Delete
          </button>
        </>
      }
    >
      <p className="muted">
        {n
          ? `${rest[noun] ?? ""}. The thread shows “You deleted this ${noun}.” in its place. You can’t undo this.`
          : `${gone[noun] ?? ""} You can’t undo this.`}
      </p>
    </Modal>
  );
}

/** The record key a hide record names, from an item key. */
const recordKey = (key: string) => {
  const [k, th = "", sub = ""] = key.split(":");
  return k === "a" || k === "p" ? `thread:${th}` : k === "f" ? `followup:${sub}` : `reply:${sub}`;
};

/** An item a moderator hid or removed (the mockup's modPh): a placeholder,
 * and for the space's staff Show it again on a hidden one. Show sends the
 * hide record's rev as the moderator saw it: if the author edited the item
 * meanwhile, the server refuses it as STALE, and a toast says so with no
 * action: the item's current text is on screen by then, and nothing is
 * applied again (AGENTS.md; the mockup's sx-rf-show). */
export function ModNote({
  itemKey,
  noun,
  mod,
  by,
  space,
}: {
  itemKey: string;
  noun: string;
  mod: Moderated;
  by: string;
  space: Space;
}) {
  const w = useWorld();
  const write = useWrite();
  const rev = useRecords((r) => r.get("hide", recordKey(itemKey))?.rev ?? 0, [itemKey]) ?? 0;
  const show = async (base: number) => {
    const o = await write(
      "moderation.decide",
      { item: itemKey, decision: "shown", base: { rev: base } },
      { quiet: true },
    );
    if (o.ok || o.error === null) return;
    if (o.error.code === "STALE")
      toast(`Show wasn’t applied because ${by} edited the ${noun} after you chose Show.`);
    else refusalToast(o.error);
  };
  return (
    <div className="sf-modph">
      <Svg src={SFI.flag} />
      <span>
        {mod === "removed"
          ? `This ${noun} was removed by a moderator.`
          : `This ${noun} is hidden by a moderator.`}
      </span>
      {mod === "hidden" && isStaff(w.roles[space.id]) ? (
        <button className="tlink" type="button" onClick={() => void show(rev)}>
          Show it again
        </button>
      ) : null}
    </div>
  );
}

export function ItemMenu({
  item,
  space,
  label = "More actions",
}: {
  item: Item;
  space: Space;
  label?: string;
}) {
  const w = useWorld();
  const write = useWrite();
  const [open, setOpen] = useState(false);
  const [dlg, setDlg] = useState<"report" | "remove" | "delete" | null>(null);
  useOverlay(open, () => setOpen(false));
  const staff = isStaff(w.roles[space.id]);
  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <span className="sf-imw sf-pend">
      <button
        className="act sf-im"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title="More"
        onClick={() => setOpen((o) => !o)}
      >
        <Svg src={SFI.more} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop cs-pop sf-ipop" role="menu">
            {item.own ? null : (
              <button
                className="um-item"
                type="button"
                role="menuitem"
                onClick={pick(() => (w.me ? setDlg("report") : undefined))}
              >
                <Svg src={SFI.flag} />
                <span>Report a problem</span>
              </button>
            )}
            <button
              className="um-item"
              type="button"
              role="menuitem"
              onClick={pick(() => {
                void navigator.clipboard?.writeText(item.url).catch(() => undefined);
                toast("Link copied.");
              })}
            >
              <Svg src={CI.link} />
              <span>Copy link</span>
            </button>
            {item.own ? (
              <button
                className="um-item cx-danger-i"
                type="button"
                role="menuitem"
                onClick={pick(() => setDlg("delete"))}
              >
                <Svg src={TRASH} />
                <span>Delete</span>
              </button>
            ) : null}
            {staff ? (
              <>
                <div className="ts-ddsep" />
                {item.mod === "hidden" ? null : (
                  <button
                    className="um-item"
                    type="button"
                    role="menuitem"
                    onClick={pick(
                      () =>
                        void write("moderation.decide", {
                          item: item.key,
                          decision: "hidden",
                        }).then((o) => {
                          if (o.ok)
                            toast(
                              `Hidden. People see “This ${item.noun} is hidden by a moderator.”`,
                            );
                        }),
                    )}
                  >
                    <Svg src={CI.eyeOff} />
                    <span>Hide</span>
                  </button>
                )}
                <button
                  className="um-item cx-danger-i"
                  type="button"
                  role="menuitem"
                  onClick={pick(() => setDlg("remove"))}
                >
                  <Svg src={I.close} />
                  <span>Remove</span>
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      {dlg === "report" ? (
        <ReportDialog item={item} space={space} onClose={() => setDlg(null)} />
      ) : null}
      {dlg === "remove" ? <RemoveDialog item={item} onClose={() => setDlg(null)} /> : null}
      {dlg === "delete" ? <DeleteDialog item={item} onClose={() => setDlg(null)} /> : null}
    </span>
  );
}
