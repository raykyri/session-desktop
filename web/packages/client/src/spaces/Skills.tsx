// Manage › Skills (the mockup's abSkillsManage): the space's skills in their
// About order, Add a skill and Edit (one dialog: name, description,
// instructions, and a preview of the row in About and of its SKILL.md), and
// Remove (confirmed). An edit sends the version it opened; a save someone
// else made meanwhile comes back as CONFLICT, and the dialog offers Reload
// or Overwrite.

import { useState } from "react";

import { spaceName } from "../data/format.js";
import type { Space } from "../data/spaces.js";
import { useRecords, useSession } from "../sync/react.js";

import { Modal } from "./Page.js";
import { Svg } from "./Svg.js";
import { MII, SVG } from "./icons.js";
import { WRITE_ERROR, refusalToast, toast, useCreate, useWrite } from "./writes.js";

/** A skill's prompt: its description, a blank line, its instructions. */
export const skParse = (t: string) => {
  const s = t.trim();
  const k = s.indexOf("\n\n");
  return k < 0 ? { d: s, b: "" } : { d: s.slice(0, k).trim(), b: s.slice(k + 2).trim() };
};
const skJoin = (d: string, b: string) => d.trim() + (b.trim() ? `\n\n${b.trim()}` : "");
const skFile = (n: string, d: string, b: string) =>
  `---\nname: ${n}\ndescription: ${d}\n---\n${b ? `\n${b}\n` : ""}`;

interface Draft {
  id: string | null;
  n: string;
  d: string;
  b: string;
  ver: number;
}

function check(x: Draft, names: string[]): Record<"n" | "d", string> {
  const n: string[] = [];
  const d: string[] = [];
  const name = x.n.trim();
  if (!name) n.push("Add a name.");
  else {
    if (name.length > 64) n.push("Use 64 characters or fewer for the name.");
    if (!/^[a-z0-9-]+$/.test(name))
      n.push("Use only lowercase letters, numbers and hyphens in the name.");
    if (/anthropic|claude/.test(name)) n.push("The name cannot contain “anthropic” or “claude”.");
    if (names.includes(name)) n.push("Another skill in this space has this name.");
  }
  if (!x.d.trim()) d.push("Add a description.");
  else {
    if (x.d.length > 1024) d.push("Use 1,024 characters or fewer for the description.");
    if (/<[^>]+>/.test(x.d)) d.push("Remove the XML tags from the description.");
  }
  return { n: n.join(" "), d: d.join(" ") };
}

function Editor({
  s,
  draft,
  others,
  onClose,
}: {
  s: Space;
  draft: Draft;
  others: string[];
  onClose: () => void;
}) {
  const write = useWrite();
  const create = useCreate();
  const session = useSession();
  const [ed, setEd] = useState(draft);
  const [seen, setSeen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const errs = check(ed, others);
  const isNew = ed.id === null;
  const save = async (force: boolean) => {
    setSeen(true);
    if (errs.n || errs.d) return;
    const name = ed.n.trim();
    const prompt = skJoin(ed.d, ed.b);
    // a new skill is a create: one that got no answer is sent again as the
    // same skill (`useCreate`)
    const o = isNew
      ? await create.send("skills.create", (id) => ({ id, space: s.id, name, prompt }), {
          quiet: true,
        })
      : await write(
          "skills.update",
          {
            id: ed.id,
            space: s.id,
            name,
            prompt,
            base: { rev: ed.ver },
            ...(force ? { force: true } : {}),
          },
          { quiet: true },
        );
    if (o.ok) {
      onClose();
      toast(isNew ? `Added ${name}. It shows in About.` : `Saved ${name}.`);
    } else if (o.error?.code === "CONFLICT" && !isNew && /first/.test(o.error.message))
      setConflict(true);
    else if (o.error) refusalToast(o.error);
    else toast(WRITE_ERROR["unavailable"] ?? "");
  };
  const reload = () => {
    const cur = ed.id ? session?.reader().get("skill", ed.id) : undefined;
    if (!cur) return;
    void navigator.clipboard?.writeText(skFile(ed.n, ed.d, ed.b)).catch(() => undefined);
    const { d, b } = skParse(cur.prompt);
    setEd({ ...ed, n: cur.name, d, b, ver: cur.ver });
    setConflict(false);
    toast("Copied your text.");
  };
  return (
    <Modal
      title={isNew ? "Add a skill" : "Edit skill"}
      className="cs-m ab-sked ab-sked-preview"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={() => void save(false)}>
            {isNew ? "Add skill" : "Save"}
          </button>
        </>
      }
    >
      {conflict ? (
        <div className="cs-strip warn ed-cf" role="alert">
          <Svg src={MII.changed} />
          <span className="grow">
            <b>Someone else changed this skill while you were editing.</b> Your text is still in the
            editor.
          </span>
          <span className="ed-cf-a">
            <button className="btn sm" type="button" onClick={reload}>
              Copy my text and reload
            </button>
            <button className="btn sm" type="button" onClick={() => void save(true)}>
              Overwrite
            </button>
          </span>
        </div>
      ) : null}
      <div className="ab-ske2">
        <div className="ab-ske">
          <div className="fld ab-skfld">
            <label htmlFor="ab-sk-n">
              <span>Name</span>
            </label>
            <input
              id="ab-sk-n"
              type="text"
              value={ed.n}
              placeholder="summarizing-papers"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setEd({ ...ed, n: e.currentTarget.value })}
            />
            <p className="ab-skhint" id="ab-sk-n-h">
              Lowercase letters, numbers and hyphens, up to 64 characters. Members type it as{" "}
              <code>/name</code>.
            </p>
            {seen && errs.n ? <p className="ab-skerr">{errs.n}</p> : null}
          </div>
          <div className="fld ab-skfld">
            <label htmlFor="ab-sk-d">
              <span>Description</span>
              <small className="ab-skc">{ed.d.length.toLocaleString("en-US")} / 1,024</small>
            </label>
            <textarea
              id="ab-sk-d"
              className="cs-ta"
              rows={3}
              value={ed.d}
              placeholder="Summarizes a research paper: the claim, the method and the results. Use when someone gives an arXiv ID."
              onChange={(e) => setEd({ ...ed, d: e.currentTarget.value })}
            />
            <p className="ab-skhint">
              What the skill does and when to use it, in the third person.
            </p>
            {seen && errs.d ? <p className="ab-skerr">{errs.d}</p> : null}
          </div>
          <div className="fld ab-skfld">
            <label htmlFor="ab-sk-b">
              <span>Instructions</span>
              <small className="ab-skc">Markdown, optional</small>
            </label>
            <textarea
              id="ab-sk-b"
              className="cs-ta ab-mono"
              rows={9}
              spellCheck={false}
              placeholder={"## Steps\n1. …"}
              value={ed.b}
              onChange={(e) => setEd({ ...ed, b: e.currentTarget.value })}
            />
            <p className="ab-skhint">
              The steps and output format the agent follows when it uses the skill. Leave out what
              the agent already knows.
            </p>
          </div>
        </div>
        <aside className="ab-skprev" aria-label="Preview">
          <span className="ab-skl">In About</span>
          <div className="sk-row ab-skrp">
            <span className="sk-tx">
              <b>{ed.n || "name"}</b>
              <small>{ed.d || "Description"}</small>
            </span>
          </div>
          <span className="ab-skl">SKILL.md</span>
          <pre className="ab-skpre">{skFile(ed.n, ed.d, ed.b)}</pre>
        </aside>
      </div>
    </Modal>
  );
}

export function SkillsManage({ s }: { s: Space }) {
  const write = useWrite();
  const list =
    useRecords(
      (r) =>
        (r.get("skills", s.id)?.order ?? []).flatMap((id) => {
          const k = r.get("skill", id);
          return k ? [k] : [];
        }),
      [s.id],
    ) ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rm, setRm] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="cs-set st-side ab-skmg">
      <section className="st-sec">
        <div className="st-head">
          <h3>Skills</h3>
          <p>Agent skills members can use in asks in this space. Shown in About in this order.</p>
        </div>
        <div className="st-body">
          <div className="ab-skl-list">
            {list.length ? (
              list.map((k) => (
                <div className="ab-skr" key={k.id}>
                  <span className="sk-tx">
                    <b>{k.name}</b>
                    <small>{skParse(k.prompt).d}</small>
                  </span>
                  <span className="ab-pgb">
                    <button
                      className="btn sm"
                      type="button"
                      onClick={() =>
                        setDraft({ id: k.id, n: k.name, ...skParse(k.prompt), ver: k.ver })
                      }
                    >
                      Edit
                    </button>
                    <button
                      className="btn sm"
                      type="button"
                      onClick={() => setRm({ id: k.id, name: k.name })}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <p className="muted cs-small">No skills yet.</p>
            )}
          </div>
          <button
            className="btn sm cs-b st-add"
            type="button"
            onClick={() => setDraft({ id: null, n: "", d: "", b: "", ver: 0 })}
          >
            <Svg src={SVG.PLUS} />
            Add a skill
          </button>
        </div>
      </section>
      {draft ? (
        <Editor
          s={s}
          draft={draft}
          others={list.filter((k) => k.id !== draft.id).map((k) => k.name)}
          onClose={() => setDraft(null)}
        />
      ) : null}
      {rm ? (
        <Modal
          title={`Remove ${rm.name}?`}
          role="alertdialog"
          onClose={() => setRm(null)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="btn" type="button" onClick={() => setRm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  const x = rm;
                  setRm(null);
                  void write("skills.remove", { space: s.id, id: x.id }).then((o) => {
                    if (o.ok) toast(`Removed ${x.name}.`);
                  });
                }}
              >
                Remove
              </button>
            </>
          }
        >
          <p className="muted">
            Members can no longer use it in asks in {spaceName(s)}. Answers that already used it
            stay in their threads.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
