// A space's page (the mockup's ab-page, `/s/<space>/pages/<slug>`): the
// page with its editors and the threads that link to it; Edit opens the
// editor (blank lines separate blocks), Save sends the version the editor
// opened, and a save someone else made meanwhile comes back as CONFLICT:
// the notice offers Copy my text and reload, or Overwrite (confirmed).
// History lists the page's versions.

import type { PageRec } from "@session/mutators";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { agoText, spaceName } from "../data/format.js";
import { isStaff, threadRows } from "../data/spaces.js";
import { Markdown } from "../features/markdown/index.js";
import { useNow, useRecords, useSession } from "../sync/react.js";

import { LeaveGuard } from "./Discard.js";
import { MissingSpace } from "./Membership.js";
import { Modal, NotFound, Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { Author, Avatar, Glyph } from "./atoms.js";
import { CI, MII, NVI, QTI } from "./icons.js";
import { canRead, useWorld } from "./world.js";
import { refusalToast, toast, useCreate, useWrite } from "./writes.js";

const EDIT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z"/></svg>';

const minutes = (text: string[]) =>
  Math.max(1, Math.round(text.join(" ").split(/\s+/).length / 200));

interface Editing {
  title: string;
  body: string;
  /** The version the editor opened (the base of the save). */
  ver: number;
  isNew: boolean;
}

interface Conflict {
  step: "conflict" | "reloaded";
  mine: string;
}

export function PagePage({ name, slug }: { name: string; slug: string }) {
  const w = useWorld();
  const now = useNow();
  const navigate = useNavigate();
  const session = useSession();
  const write = useWrite();
  const create = useCreate();
  const s = useMemo(() => w.spaces.find((x) => x.name === name), [w.spaces, name]);
  const page = useRecords(
    (r) => (s ? (r.list("page", (p) => p.sp === s.id && p.slug === slug)[0] ?? null) : null),
    [s?.id, slug],
  );
  const linked =
    useRecords(
      (r) =>
        s && page
          ? threadRows(r, new Set([s.id]))
              .filter(
                (t) =>
                  (t.sum ?? "").includes(`/pages/${page.slug}`) || (t.q ?? "").includes(page.t),
              )
              .slice(0, 5)
          : [],
      [s?.id, page?.slug],
    ) ?? [];
  const [ed, setEd] = useState<Editing | null>(
    slug === "untitled-page" ? { title: "", body: "", ver: 0, isNew: true } : null,
  );
  const [cf, setCf] = useState<Conflict | null>(null);
  const [over, setOver] = useState(false);
  const [hist, setHist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  if (!s) {
    if (!w.loaded) return <Page place={{ kind: "other" }}>{null}</Page>;
    return <MissingSpace name={name} thread={false} />;
  }
  if (!canRead(w, s))
    return (
      <Page place={{ kind: "space", id: s.id }}>
        <NotFound space={name} />
      </Page>
    );
  const role = w.roles[s.id];
  const mayEdit = isStaff(role) || (role !== undefined && s.pageEdit === "members");
  if (!page && !ed) {
    if (!session?.status().ready) return <Page place={{ kind: "space", id: s.id }}>{null}</Page>;
    return (
      <Page place={{ kind: "space", id: s.id }}>
        <NotFound />
      </Page>
    );
  }
  const toAbout = () => void navigate({ to: "/s/$space/about", params: { space: s.name } });
  const crumb = (
    <nav className="abp-crumb" aria-label="Breadcrumb">
      <Glyph s={s} className="abp-gl" />
      <button
        className="tlink"
        type="button"
        onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
      >
        {spaceName(s)}
      </button>
      <span aria-hidden="true">/</span>
      <button className="tlink" type="button" onClick={toAbout}>
        Pages
      </button>
    </nav>
  );
  const save = async (force: boolean) => {
    if (!ed) return;
    const title = ed.title.trim();
    if (!title) return;
    const text = ed.body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    setBusy(true);
    // a new page is a create: one that got no answer is sent again as the
    // same page (`useCreate`)
    const o = ed.isNew
      ? await create.send(
          "pages.update",
          (id) => ({ space: s.id, page: null, id, title, text, ...(force ? { force: true } : {}) }),
          { quiet: true },
        )
      : await write(
          "pages.update",
          {
            space: s.id,
            page: page?.id,
            base: { rev: ed.ver },
            title,
            text,
            ...(force ? { force: true } : {}),
          },
          { quiet: true },
        );
    setBusy(false);
    if (o.ok) {
      setEd(null);
      setCf(null);
      toast(ed.isNew ? "Page added." : "Page saved.");
      const saved = session?.reader().get("page", (o.result as { id: string }).id);
      if (saved && saved.slug !== slug)
        void navigate({
          to: "/s/$space/pages/$slug",
          params: { space: s.name, slug: saved.slug },
          replace: true,
        });
    } else if (o.error?.code === "CONFLICT")
      setCf({ step: "conflict", mine: `${ed.title}\n\n${ed.body}` });
    else if (o.error) refusalToast(o.error);
    else
      toast("Couldn’t reach the server, so Session didn’t save the page. Try again in a moment.");
  };
  const reload = () => {
    if (!ed || !page) return;
    const mine = `${ed.title}\n\n${ed.body}`;
    void navigator.clipboard?.writeText(mine).catch(() => undefined);
    setEd({ title: page.t, body: page.text.join("\n\n"), ver: page.ver, isNew: false });
    setCf({ step: "reloaded", mine });
  };
  const savedBy = page ? (page.revs[0]?.by ?? page.ed ?? page.by) : "";
  const savedAt = page?.revs[0]?.createdAt;
  return (
    <Page place={{ kind: "space", id: s.id }}>
      <div className="home-wide ab-page">
        {ed ? (
          <div className="abp abp-article">
            {crumb}
            <div className="abp-ed">
              <div className="abp-edbar">
                <span>{ed.isNew ? "New page" : "Editing"}</span>
                <span className="abp-edb-a">
                  <button
                    className="btn sm"
                    type="button"
                    onClick={() => {
                      setEd(null);
                      setCf(null);
                      if (ed.isNew) toAbout();
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn sm primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void save(false)}
                  >
                    Save
                  </button>
                </span>
              </div>
              {cf?.step === "conflict" ? (
                <div className="cs-strip warn ed-cf" role="alert">
                  <Svg src={MII.changed} />
                  <span className="grow">
                    <b>Someone else changed this page while you were editing.</b> {savedBy} saved a
                    new version {savedAt ? agoText(savedAt, now) : "just now"}. Your text is still
                    in the editor.
                  </span>
                  <span className="ed-cf-a">
                    <button className="btn sm" type="button" onClick={reload}>
                      Copy my text and reload
                    </button>
                    <button className="btn sm" type="button" onClick={() => setOver(true)}>
                      Overwrite
                    </button>
                  </span>
                </div>
              ) : cf?.step === "reloaded" ? (
                <>
                  <div className="cs-strip ed-cf" role="status">
                    <Svg src={MII.changed} />
                    <span className="grow">
                      The editor now has the version {savedBy} saved. Your text is on the clipboard
                      and below. Make your changes again, then save.
                    </span>
                  </div>
                  <div className="ed-mine">
                    <div className="ed-mine-h">
                      <b id="ed-mine-l">Your text</b>
                      <span className="ed-cf-a">
                        <button
                          className="btn sm"
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(cf.mine).catch(() => undefined);
                            toast("Copied your text.");
                          }}
                        >
                          Copy
                        </button>
                        <button className="btn sm" type="button" onClick={() => setCf(null)}>
                          Hide
                        </button>
                      </span>
                    </div>
                    <textarea
                      className="cs-ta ed-mine-t"
                      rows={5}
                      readOnly
                      aria-labelledby="ed-mine-l"
                      value={cf.mine}
                    />
                  </div>
                </>
              ) : null}
              <input
                id="ab-pg-t"
                className="abp-edt"
                type="text"
                value={ed.title}
                placeholder="Page title"
                aria-label="Page title"
                onChange={(e) => setEd({ ...ed, title: e.currentTarget.value })}
              />
              <textarea
                id="ab-pg-b"
                className="abp-edx"
                rows={12}
                placeholder="Write the page"
                aria-label="Page text"
                value={ed.body}
                onChange={(e) => setEd({ ...ed, body: e.currentTarget.value })}
              />
              <p className="cs-fine ab-f">
                Blank lines separate blocks. A block that starts with ## is a heading; lines that
                start with - are a list.
              </p>
            </div>
            <LeaveGuard
              when={() =>
                !busy &&
                (ed.isNew
                  ? !!(ed.title || ed.body)
                  : !!page && (ed.title !== page.t || ed.body !== page.text.join("\n\n")))
              }
              title={ed.isNew ? "Discard this page?" : "Discard your changes to this page?"}
              body={
                ed.isNew
                  ? "The title and text you wrote will be deleted."
                  : "The page stays as it was before you edited it."
              }
            />
          </div>
        ) : page ? (
          <article className="abp abp-article">
            <div className="abp-top">
              {crumb}
              <div className="abp-tools">
                {mayEdit ? (
                  <button
                    className="iconbtn abp-ib"
                    type="button"
                    aria-label="Edit"
                    title="Edit"
                    onClick={() =>
                      setEd({
                        title: page.t,
                        body: page.text.join("\n\n"),
                        ver: page.ver,
                        isNew: false,
                      })
                    }
                  >
                    <Svg src={EDIT} />
                  </button>
                ) : null}
                <button
                  className="iconbtn abp-ib"
                  type="button"
                  aria-label="History"
                  title="History"
                  aria-pressed={hist}
                  onClick={() => setHist((h) => !h)}
                >
                  <Svg src={CI.clock} />
                </button>
                {isStaff(role) ? (
                  <button
                    className="iconbtn abp-ib"
                    type="button"
                    aria-label="Remove page"
                    title="Remove page"
                    onClick={() => setRemoving(true)}
                  >
                    <Svg src={NVI.trash} />
                  </button>
                ) : null}
                <button
                  className="iconbtn abp-ib"
                  type="button"
                  aria-label="Copy link"
                  title="Copy link"
                  onClick={() => {
                    void navigator.clipboard?.writeText(location.href).catch(() => undefined);
                    toast("Link copied.");
                  }}
                >
                  <Svg src={CI.link} />
                </button>
              </div>
            </div>
            <header className="abp-hd">
              <h1>{page.t}</h1>
              <div className="abp-by">
                <span className="abp-avs">
                  {[...new Set([page.ed ?? page.by, page.by])].map((u) => (
                    <Avatar key={u} u={u} className="sm" />
                  ))}
                </span>
                <span>
                  Edited by <Author u={page.ed ?? page.by} /> {savedAt ? agoText(savedAt, now) : ""}{" "}
                  · created by <Author u={page.by} /> · {minutes(page.text)} min read
                </span>
              </div>
            </header>
            {hist ? <History page={page} now={now} canEdit={mayEdit} /> : null}
            <div className="abp-prose">
              <Markdown markdown={page.text.join("\n\n")} className="prose" />
            </div>
            <section className="abp-rel">
              <div className="abp-relh">
                <h2>Threads in {spaceName(s)} that link to this page</h2>
              </div>
              {linked.length ? (
                <ul>
                  {linked.map((t) => (
                    <li key={t.id}>
                      <button
                        className="abp-th"
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/s/$space/t/$thread",
                            params: { space: s.name, thread: t.id },
                          })
                        }
                      >
                        <b>{t.q}</b>
                        <small>{t.u}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No threads link to this page yet.</p>
              )}
              <button
                className="btn sm abp-ask"
                type="button"
                onClick={() => void navigate({ to: "/s/$space", params: { space: s.name } })}
              >
                <Svg src={QTI.ask} />
                Ask about this page
              </button>
            </section>
          </article>
        ) : null}
      </div>
      {removing && page ? (
        <Modal
          title={`Remove ${page.t}?`}
          role="alertdialog"
          onClose={() => setRemoving(false)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="btn" type="button" onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  setRemoving(false);
                  void write("pages.remove", { space: s.id, page: page.id }).then((o) => {
                    if (o.ok) {
                      toast("Page removed.");
                      toAbout();
                    }
                  });
                }}
              >
                Remove page
              </button>
            </>
          }
        >
          <p className="muted">
            The page leaves {spaceName(s)}’s About. Threads that link to it keep their text.
          </p>
        </Modal>
      ) : null}
      {over && ed ? (
        <Modal
          title={`Overwrite ${savedBy}’s version?`}
          role="alertdialog"
          onClose={() => setOver(false)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button className="btn" type="button" onClick={() => setOver(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  setOver(false);
                  void save(true);
                }}
              >
                Overwrite
              </button>
            </>
          }
        >
          <p className="muted">
            Your text replaces the version {savedBy} saved
            {savedAt ? ` ${agoText(savedAt, now)}` : ""}. Their version stays in the page history.
          </p>
        </Modal>
      ) : null}
    </Page>
  );
}

function History({ page, now, canEdit }: { page: PageRec; now: number; canEdit: boolean }) {
  const write = useWrite();
  // an earlier version comes back as a new one; the history keeps both
  const restore = async (k: number, force: boolean) => {
    const r = page.revs[k];
    if (!r) return;
    const o = await write(
      "pages.restore",
      {
        space: page.sp,
        page: page.id,
        rev: k,
        note: `Restored the version from ${agoText(r.createdAt, now)}`,
        base: { rev: page.ver },
        ...(force ? { force: true } : {}),
      },
      { quiet: true },
    );
    if (o.ok) toast("Restored. The page history keeps both versions.");
    else if (o.error?.code === "CONFLICT")
      toast("Someone else changed this page after you opened its history.", {
        label: "Restore anyway",
        run: () => void restore(k, true),
      });
    else if (o.error) refusalToast(o.error);
  };
  return (
    <section className="abp-hist" aria-label="History">
      <ol>
        {page.revs.map((r, k) => (
          <li key={k}>
            <Avatar u={r.by} className="sm" />
            <span>
              <b>{r.by}</b> {r.note} <span className="faint">{agoText(r.createdAt, now)}</span>
            </span>
            {canEdit && k > 0 ? (
              <button className="tlink" type="button" onClick={() => void restore(k, false)}>
                Restore
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
