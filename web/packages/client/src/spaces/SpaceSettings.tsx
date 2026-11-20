// Manage › Settings (the mockup's csSettings, for a space's admins and
// owner): About (name, title, description), Rules, Visibility, Joining,
// Questions for applicants, Landing page, Posts and who edits pages, with
// Discard changes and Save changes at the end (spaces.update; rules changed
// by someone else meanwhile come back as CONFLICT, and Overwrite sends
// force); and, for the owner, Archive and Delete.

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import { fmt, spaceName } from "../data/format.js";
import type { Space } from "../data/spaces.js";
import { useRecords } from "../sync/react.js";

import { LeaveGuard } from "./Discard.js";
import { Modal } from "./Page.js";
import { Svg } from "./Svg.js";
import { I, SVG } from "./icons.js";
import { useWorld } from "./world.js";
import { refusalToast, toast, useWrite } from "./writes.js";

interface Draft {
  name: string;
  title: string;
  desc: string;
  rules: string;
  vis: Space["vis"];
  policy: "request" | "invite";
  invite: "mods" | "members";
  qs: { q: string; req: boolean }[];
  faq: boolean;
  postsOff: boolean;
  pageEdit: "mods" | "members";
}

const draftOf = (s: Space, rules: string[]): Draft => ({
  name: s.name,
  title: s.title,
  desc: s.desc,
  rules: rules.join("\n"),
  vis: s.vis,
  policy: s.policy ?? "request",
  invite: s.invite ?? "mods",
  qs: s.qs.length ? s.qs.map((q) => ({ ...q })) : [{ q: "", req: true }],
  faq: s.faq,
  postsOff: s.postsOff,
  pageEdit: s.pageEdit ?? "mods",
});

function Sec({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="st-sec">
      <div className="st-head">
        <h3>{title}</h3>
        {sub ? <p>{sub}</p> : null}
      </div>
      <div className="st-body">{children}</div>
    </section>
  );
}

function Toggle({
  on,
  title,
  sub,
  set,
}: {
  on: boolean;
  title: string;
  sub: string;
  set: (v: boolean) => void;
}) {
  return (
    <label className="sf-tog">
      <span className="sf-tog-tx">
        <b>{title}</b>
        <small>{sub}</small>
      </span>
      <span className="ts-sw">
        <input
          type="checkbox"
          checked={on}
          aria-label={title}
          onChange={(e) => set(e.currentTarget.checked)}
        />
        <span className="sw-track" aria-hidden="true" />
      </span>
    </label>
  );
}

export function SettingsManage({ s }: { s: Space }) {
  const w = useWorld();
  const write = useWrite();
  const navigate = useNavigate();
  const rec = useRecords((r) => r.get("space", s.id) ?? null, [s.id]);
  const owner = w.roles[s.id] === "owner";
  const [d, setD] = useState<Draft>(() => draftOf(s, rec?.rules ?? s.rules));
  const [rulesRev] = useState(rec?.rulesRev ?? 0);
  const [conflict, setConflict] = useState(false);
  const [dlg, setDlg] = useState<"archive" | "delete" | null>(null);
  const [delName, setDelName] = useState("");
  const base = draftOf(s, rec?.rules ?? s.rules);
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  // set while a save goes to a renamed space's address
  const saving = useRef(false);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const save = async (force: boolean) => {
    const closed = d.vis !== "open";
    saving.current = true;
    const o = await write(
      "spaces.update",
      {
        id: s.id,
        set: {
          name: d.name,
          title: d.title,
          desc: d.desc,
          rules: d.rules
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          vis: d.vis,
          ...(closed
            ? { policy: d.vis === "unlisted" ? "invite" : d.policy, invite: d.invite }
            : {}),
          ...(closed && d.policy === "request" ? { qs: d.qs.filter((q) => q.q.trim()) } : {}),
          faq: d.faq,
          postsOff: d.postsOff,
          pageEdit: d.pageEdit,
        },
        base: { rulesRev },
        ...(force ? { force: true } : {}),
      },
      { quiet: true },
    );
    if (o.ok) {
      setConflict(false);
      toast("Settings saved.");
      if (d.name !== s.name)
        void navigate({
          to: "/s/$space/manage/$tab",
          params: { space: d.name, tab: "settings" },
          replace: true,
        }).finally(() => (saving.current = false));
      else saving.current = false;
    } else if (o.error?.code === "CONFLICT" && /rules/.test(o.error.message)) setConflict(true);
    else if (o.error) refusalToast(o.error);
    if (!o.ok) saving.current = false;
  };
  const closed = d.vis !== "open";
  // leaving with unsaved settings asks first (the mockup's scr:settings)
  const guard = (
    <LeaveGuard
      when={() => dirty && !saving.current}
      title="Discard your changes to the settings?"
      body={`You haven’t saved your changes to the settings of ${spaceName(s)}.`}
    />
  );
  const buttons = (
    <>
      <button className="btn ghost" type="button" disabled={!dirty} onClick={() => setD(base)}>
        Discard changes
      </button>
      <button
        className="btn primary"
        type="button"
        disabled={!dirty}
        onClick={() => void save(false)}
      >
        Save changes
      </button>
    </>
  );
  return (
    <div className="cs-set st-side">
      {guard}
      {conflict ? (
        <div className="cs-strip warn ed-cf" role="alert">
          <span className="grow">
            <b>Someone else changed the rules while you were editing.</b> Your rules are still in
            the form.
          </span>
          <span className="ed-cf-a">
            <button className="btn sm" type="button" onClick={() => void save(true)}>
              Overwrite
            </button>
          </span>
        </div>
      ) : null}
      <Sec title="About" sub="The space's name, title and description.">
        <label className="fld">
          <span>Name</span>
          <input
            id="st-name"
            type="text"
            value={d.name}
            onChange={(e) => set({ name: e.currentTarget.value })}
          />
        </label>
        <label className="fld">
          <span>Title</span>
          <input
            id="st-title"
            type="text"
            value={d.title}
            onChange={(e) => set({ title: e.currentTarget.value })}
          />
        </label>
        <label className="fld">
          <span>Description</span>
          <textarea
            id="st-desc"
            className="cs-ta"
            rows={3}
            value={d.desc}
            onChange={(e) => set({ desc: e.currentTarget.value })}
          />
        </label>
      </Sec>
      <Sec title="Rules" sub="One rule per line. Members confirm them when they join.">
        <textarea
          id="st-rules"
          className="cs-ta"
          rows={5}
          aria-label="Rules"
          value={d.rules}
          onChange={(e) => set({ rules: e.currentTarget.value })}
        />
      </Sec>
      <Sec
        title="Visibility"
        sub="Who can read the space, and whether people who are not members can find it."
      >
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
                onClick={() => set({ vis: "open" })}
              >
                <Svg src={SVG.GLOBE} />
                Open
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={closed}
                onClick={() => set({ vis: closed ? d.vis : "listed" })}
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
                aria-checked={d.vis !== "unlisted"}
                disabled={!closed}
                onClick={() => set({ vis: "listed" })}
              >
                Listed
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={d.vis === "unlisted"}
                disabled={!closed}
                onClick={() => set({ vis: "unlisted" })}
              >
                Unlisted
              </button>
            </div>
          </div>
        </div>
      </Sec>
      {closed ? (
        <Sec title="Joining" sub="How people become members, and who can invite them.">
          <div className="ts-list cs-opts" role="radiogroup" aria-label="How people join">
            {(
              [
                [
                  "request",
                  "Request and approve",
                  "People answer your questions. A moderator approves each request.",
                ],
                [
                  "invite",
                  "Invite only",
                  "People join with an invite link. Each link can be used once.",
                ],
              ] as const
            ).map(([k, t, sub]) => (
              <button
                key={k}
                type="button"
                className="ts-row cs-opt"
                role="radio"
                aria-checked={d.policy === k}
                disabled={k === "request" && d.vis === "unlisted"}
                onClick={() => set({ policy: k })}
              >
                <span className="cs-radio" />
                <span className="ts-tx">
                  <b>{t}</b>
                  <small>
                    {k === "request" && d.vis === "unlisted"
                      ? "Not available for unlisted spaces: nobody can find the space to request."
                      : sub}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <div className="cs-row">
            <span className="cs-rowl">Who can invite</span>
            <div className="seg" role="radiogroup" aria-label="Who can invite">
              <button
                type="button"
                aria-pressed={d.invite === "mods"}
                onClick={() => set({ invite: "mods" })}
              >
                Moderators
              </button>
              <button
                type="button"
                aria-pressed={d.invite === "members"}
                onClick={() => set({ invite: "members" })}
              >
                All members
              </button>
            </div>
          </div>
        </Sec>
      ) : null}
      {closed && d.policy === "request" && d.vis !== "unlisted" ? (
        <Sec
          title="Questions for applicants"
          sub="Shown on the request form. Moderators see the answers in the review queue."
        >
          <div className="cs-qs">
            {d.qs.map((q, k) => (
              <div className="cs-qrow" key={k}>
                <span className="ts-n num">{k + 1}</span>
                <input
                  id={`cs-q-${k}`}
                  type="text"
                  value={q.q}
                  placeholder={`Question for applicants${q.req ? "" : " (Optional)"}`}
                  aria-label={`Question ${k + 1}`}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    set({ qs: d.qs.map((x, j) => (j === k ? { ...x, q: v } : x)) });
                  }}
                />
                <label className="st-req">
                  <span>Required</span>
                  <span className="ts-sw">
                    <input
                      type="checkbox"
                      checked={q.req}
                      aria-label={`Question ${k + 1} is required`}
                      onChange={(e) => {
                        const v = e.currentTarget.checked;
                        set({ qs: d.qs.map((x, j) => (j === k ? { ...x, req: v } : x)) });
                      }}
                    />
                    <span className="sw-track" aria-hidden="true" />
                  </span>
                </label>
                <button
                  className="iconbtn"
                  type="button"
                  aria-label={`Remove question ${k + 1}`}
                  title="Remove"
                  onClick={() => set({ qs: d.qs.filter((_, j) => j !== k) })}
                >
                  <Svg src={I.close} />
                </button>
              </div>
            ))}
            {d.qs.length < 3 ? (
              <button
                className="btn sm cs-b st-add"
                type="button"
                onClick={() => set({ qs: [...d.qs, { q: "", req: false }] })}
              >
                <Svg src={SVG.PLUS} />
                Add a question
              </button>
            ) : (
              <p className="faint cs-small">Up to 3 questions.</p>
            )}
          </div>
        </Sec>
      ) : null}
      <Sec title="Landing page" sub="What people see first when they open the space.">
        <Toggle
          on={d.faq}
          title="FAQ landing page"
          sub="The space opens on a search-and-ask box and answers grouped by topic, with recent threads below."
          set={(v) => set({ faq: v })}
        />
      </Sec>
      <Sec title="Posts" sub="Whether members can write plain posts as well as asks.">
        <Toggle
          on={!d.postsOff}
          title="Allow posts"
          sub="People can post and reply. Asks are always on."
          set={(v) => set({ postsOff: !v })}
        />
      </Sec>
      <Sec title="Pages" sub="Who edits the space's pages.">
        <div className="seg" role="radiogroup" aria-label="Who edits pages">
          <button
            type="button"
            aria-pressed={d.pageEdit === "mods"}
            onClick={() => set({ pageEdit: "mods" })}
          >
            Moderators
          </button>
          <button
            type="button"
            aria-pressed={d.pageEdit === "members"}
            onClick={() => set({ pageEdit: "members" })}
          >
            All members
          </button>
        </div>
      </Sec>
      <div className="st-end">{buttons}</div>
      {owner ? (
        <Sec title="Archive or delete" sub="Stop activity in the space, or delete it.">
          <div className="cs-row">
            {s.archived ? (
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void write("spaces.archive", { id: s.id, archived: false }).then((o) => {
                    if (o.ok) toast(`Unarchived ${spaceName(s)}.`);
                  })
                }
              >
                Unarchive
              </button>
            ) : (
              <button className="btn" type="button" onClick={() => setDlg("archive")}>
                Archive space
              </button>
            )}
            <button className="btn danger" type="button" onClick={() => setDlg("delete")}>
              Delete space
            </button>
          </div>
        </Sec>
      ) : null}
      {dlg === "archive" ? (
        <Modal
          title={`Archive ${spaceName(s)}?`}
          role="alertdialog"
          onClose={() => setDlg(null)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="btn" type="button" onClick={() => setDlg(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  setDlg(null);
                  void write("spaces.archive", { id: s.id, archived: true }).then((o) => {
                    if (o.ok) toast(`Archived ${spaceName(s)}. Threads are read-only.`);
                  });
                }}
              >
                Archive
              </button>
            </>
          }
        >
          <p className="muted">
            Nobody can ask, post, follow up or reply in {spaceName(s)}, or change its pages, skills
            or sources. Members can still read all of them. {spaceName(s)} is hidden from browse and
            search, and its header shows “Archived”.
          </p>
          <p className="cs-fine">
            <Svg src={SVG.CX_ARCH} />
            <span>You can unarchive it in Settings at any time.</span>
          </p>
        </Modal>
      ) : null}
      {dlg === "delete" ? (
        <Modal
          title={`Delete ${spaceName(s)}?`}
          role="alertdialog"
          onClose={() => setDlg(null)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="btn" type="button" onClick={() => setDlg(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                id="cx-delok"
                disabled={delName.trim() !== s.name}
                onClick={() => {
                  setDlg(null);
                  void write("spaces.delete", { id: s.id }).then((o) => {
                    if (o.ok) {
                      toast(`Deleted ${spaceName(s)}.`);
                      void navigate({ to: "/" });
                    }
                  });
                }}
              >
                Delete space
              </button>
            </>
          }
        >
          <p className="muted">
            This deletes {spaceName(s)} for everyone, with its {fmt(s.posts ?? 0)} threads, their
            follow-ups and replies, its pages and its sources. Members lose access. This can’t be
            undone.
          </p>
          {s.archived ? null : (
            <p className="cs-fine">
              <Svg src={SVG.CX_ARCH} />
              <span>To keep the threads readable, archive the space instead.</span>
            </p>
          )}
          <label className="fld">
            <span>
              Type <b>{s.name}</b> to confirm
            </span>
            <input
              id="cx-delname"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={delName}
              onChange={(e) => setDelName(e.currentTarget.value)}
            />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
