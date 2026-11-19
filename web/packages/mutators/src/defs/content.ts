// A space's skills and pages, and the sources added to it.
//
// Skills and pages are addressed by their index in the space's list, as in
// the mock. A skill's and a page's version (`rev` of a skill, `ver` of a page
// document) counts its saves; an editor sends the version it opened as
// `base`, and the save is CONFLICT when someone saved since, unless `force`
// (the mock's edit conflicts, step 9).

import { spaces } from "@session/shared";
import { z } from "zod";

import { RANK, canRead, rankIn, roleIn } from "../access.js";
import { defineMutator, inSpace, type Tx } from "../engine.js";
import { bad, refuse } from "../errors.js";
import type { PageRec, SkillsRec, SourceMeta } from "../records.js";
import { needSpace, text, writable } from "../rules.js";
import { count, ulidS } from "../schemas.js";

import { sourceMeta } from "./threads.js";

const changed = (base: number | undefined, current: number, force: boolean | undefined) =>
  !force && base !== undefined && base !== current;

// ---- skills ----

function skillsOf(tx: Tx, sp: string): SkillsRec {
  needSpace(tx, sp);
  return tx.get("skills", sp) ?? { kind: "skills", sp, list: [], rev: 0 };
}

const noSkill = () => refuse("NOT_FOUND", "The server has no record of this skill.");

// ---- pages ----

/** A page's key part: its title in lower case, runs of other characters as "-". */
export const pageSlug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The space's page list. */
function pagesOf(tx: Tx, sp: string): [string, string][] {
  needSpace(tx, sp);
  return tx.get("pages", sp)?.list ?? [];
}

function pageAt(tx: Tx, sp: string, index: number): [string, string] {
  const pg = pagesOf(tx, sp)[index];
  if (!pg)
    throw refuse(
      "NOT_FOUND",
      "The server has no record of this page. Someone may have deleted it.",
    );
  return pg;
}

/** A page's document, or the empty one a listed page without a stored
 * document stands for (the mock takes its author and history from the
 * client's `base`; a write never stores client-made history here). */
function docOf(tx: Tx, sp: string, title: string): Omit<PageRec, "rev"> {
  const slug = pageSlug(title);
  const d = tx.get("page", `${sp}:${slug}`);
  if (d) return d;
  return { kind: "page", sp, slug, t: title, text: [""], by: tx.me, ed: null, ver: 0, revs: [] };
}

/** Who edits pages (the space's `pageEdit`): moderators; with "members", its
 * members too. */
function pageEditor(tx: Tx, sp: string) {
  const scope = inSpace(tx, sp, "member");
  const s = needSpace(tx, sp);
  const ok =
    rankIn(tx, sp, tx.me) >= RANK.mod || (s.pageEdit === "members" && !!roleIn(tx, sp, tx.me));
  if (!ok)
    throw refuse(
      "FORBIDDEN",
      `In #${s.name}, ${s.pageEdit === "members" ? "members" : "moderators"} edit pages.`,
    );
  return scope;
}

/** The base an editor sends: the document's version it opened. The mock's
 * stand-in fields (`by`, `ed`, `revs`) are accepted and not stored. */
const pageBaseS = spaces.pageBaseSchema.strict();

// ---- sources ----

/** What Session reads from a URL or a file name (the mock's `sourceFor`). */
function sourceFor(url: string | undefined, file: string | undefined): SourceMeta {
  const u = (url ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "");
  const host = (u.split("/")[0] ?? u).toLowerCase();
  const pl =
    file || /\.pdf$/i.test(u)
      ? "pdf"
      : /^(x|twitter)\.com/.test(host)
        ? "x"
        : /youtube|youtu\.be/.test(host)
          ? "yt"
          : /arxiv/.test(host)
            ? "arxiv"
            : /substack/.test(host)
              ? "substack"
              : /lesswrong/.test(host)
                ? "lw"
                : "web";
  const form = pl === "x" ? "post" : pl === "yt" ? "video" : "article";
  const raw = (file || u.split("/").slice(1).filter(Boolean).pop() || host)
    .replace(/\.(pdf|html?)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const handle = "@" + (u.split("/")[1] || "x");
  return {
    pl,
    form,
    au: pl === "x" ? handle : file ? "Uploaded file" : host,
    h: host,
    len:
      pl === "pdf" || pl === "arxiv"
        ? "PDF, 12 pages"
        : form === "video"
          ? "24 min"
          : form === "post"
            ? "1 post"
            : "6 min read",
    tok: pl === "pdf" ? 9e3 : 2e3,
    url: file ? "session.app/files/" + encodeURIComponent(file) : u,
    t: form === "post" ? null : raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : host,
    desc: "",
    sum: "",
    body: [
      {
        p: form === "post" ? `Post by ${pl === "x" ? handle : host}.` : "Reader copy of the page.",
      },
    ],
  };
}

/** A URL as the mock compares them: no scheme, "www.", query, fragment or
 * trailing "/", in lower case. */
const normUrl = (u: string) =>
  u
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const contentMutators = [
  defineMutator({
    name: "skills.create",
    input: z.strictObject({ space: ulidS, name: z.string(), prompt: z.string() }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const l = skillsOf(tx, i.space);
      if (l.list.some((x) => x.name === i.name))
        throw refuse("CONFLICT", `The space has a skill named ${i.name}.`);
      tx.put({ ...l, list: [...l.list, { name: i.name, prompt: i.prompt, rev: 0 }] });
      return null;
    },
  }),

  defineMutator({
    name: "skills.update",
    input: z.strictObject({
      space: ulidS,
      index: count,
      name: z.string(),
      prompt: z.string(),
      base: z.strictObject({ rev: count }).optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const l = skillsOf(tx, i.space);
      const row = l.list[i.index];
      if (!row) throw noSkill();
      if (changed(i.base?.rev, row.rev, i.force))
        throw refuse("CONFLICT", "Someone else changed this skill first.");
      if (l.list.some((x, k) => k !== i.index && x.name === i.name))
        throw refuse("CONFLICT", `The space has a skill named ${i.name}.`);
      const list = l.list.map((x, k) =>
        k === i.index ? { name: i.name, prompt: i.prompt, rev: row.rev + 1 } : x,
      );
      tx.put({ ...l, list });
      return null;
    },
  }),

  defineMutator({
    name: "skills.remove",
    input: z.strictObject({ space: ulidS, index: count }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const l = skillsOf(tx, i.space);
      if (!l.list[i.index]) throw noSkill();
      tx.put({ ...l, list: l.list.filter((_, k) => k !== i.index) });
      return null;
    },
  }),

  defineMutator({
    name: "skills.reorder",
    input: z.strictObject({ space: ulidS, from: count, to: count }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const l = skillsOf(tx, i.space);
      const x = l.list[i.from];
      if (!x || !l.list[i.to]) throw noSkill();
      const list = l.list.filter((_, k) => k !== i.from);
      list.splice(i.to, 0, x);
      tx.put({ ...l, list });
      return null;
    },
  }),

  // Add a page (`page` null) or edit one (`page`: its index).
  defineMutator({
    name: "pages.update",
    input: z.strictObject({
      space: ulidS,
      page: count.nullable().optional(),
      title: z.string(),
      text: z.array(z.string()),
      base: pageBaseS.optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const title = text(i.title, "title");
      const body = i.text.length ? i.text : [""];
      const list = pagesOf(tx, i.space);
      const slug = pageSlug(title);
      if (i.page === null || i.page === undefined) {
        tx.put({ kind: "pages", sp: i.space, list: [...list, [title, tx.now]] });
        tx.put({
          kind: "page",
          sp: i.space,
          slug,
          t: title,
          text: body,
          by: tx.me,
          ed: tx.me,
          ver: 1,
          revs: [{ by: tx.me, note: "Created the page", createdAt: tx.now }],
        });
        return null;
      }
      const [old] = pageAt(tx, i.space, i.page);
      const doc = docOf(tx, i.space, old);
      if (changed(i.base?.rev, doc.ver, i.force))
        throw refuse("CONFLICT", "Someone else changed this page first.");
      const at = i.page;
      tx.put({
        kind: "pages",
        sp: i.space,
        list: list.map((p, k): [string, string] => (k === at ? [title, tx.now] : p)),
      });
      if (pageSlug(old) !== slug) tx.del("page", `${i.space}:${pageSlug(old)}`);
      tx.put({
        kind: "page",
        sp: i.space,
        slug,
        t: title,
        text: body,
        by: doc.by,
        ed: tx.me,
        ver: doc.ver + 1,
        revs: [{ by: tx.me, note: "Edited the page", createdAt: tx.now }, ...doc.revs],
      });
      return null;
    },
  }),

  // Restore an earlier version: the history keeps both (`note`: the history
  // line, written by the page; `rev`: the version's index in the history).
  defineMutator({
    name: "pages.restore",
    input: z.strictObject({
      space: ulidS,
      page: count,
      rev: count,
      note: z.string(),
      base: pageBaseS.optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const [title] = pageAt(tx, i.space, i.page);
      const doc = docOf(tx, i.space, title);
      if (changed(i.base?.rev, doc.ver, i.force))
        throw refuse("CONFLICT", "Someone else changed this page first.");
      if (!doc.revs[i.rev]) throw refuse("NOT_FOUND", "The server has no record of this version.");
      tx.put({
        ...doc,
        ed: tx.me,
        ver: doc.ver + 1,
        revs: [{ by: tx.me, note: i.note, createdAt: tx.now }, ...doc.revs],
      });
      return null;
    },
  }),

  defineMutator({
    name: "pages.remove",
    input: z.strictObject({ space: ulidS, page: count }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const [title] = pageAt(tx, i.space, i.page);
      const list = pagesOf(tx, i.space).filter((_, k) => k !== i.page);
      tx.put({ kind: "pages", sp: i.space, list });
      tx.del("page", `${i.space}:${pageSlug(title)}`);
      return null;
    },
  }),

  // Swap a page with another in the list.
  defineMutator({
    name: "pages.move",
    input: z.strictObject({ space: ulidS, from: count, to: count }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const a = pageAt(tx, i.space, i.from);
      const b = pageAt(tx, i.space, i.to);
      const list = pagesOf(tx, i.space).map((p, k) => (k === i.from ? b : k === i.to ? a : p));
      tx.put({ kind: "pages", sp: i.space, list });
      return null;
    },
  }),

  // Add a source to a space: one Session has (`source`), or a URL or a file
  // it reads now (a new source, id derived from the mutation). The space's
  // source policy decides with the actor's role: "members" adds it, "review"
  // makes a member's source wait for a moderator, "mods" lets only
  // moderators add. A known URL is one in Session's catalog or in a space's
  // sources the actor may read.
  defineMutator({
    name: "spaceSources.add",
    input: z.strictObject({
      space: ulidS,
      source: z.string().regex(SOURCE_ID).optional(),
      url: z.string().optional(),
      file: z.string().optional(),
      note: z.string().optional(),
    }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "member");
      const s = needSpace(tx, i.space);
      if (s.srcPolicy === "mods" && rankIn(tx, i.space, tx.me) < RANK.mod)
        throw refuse("FORBIDDEN", "Only moderators add sources to this space.");
      return scope;
    },
    run: (tx, i) => {
      const s = writable(tx, i.space);
      let id: string;
      let meta: SourceMeta;
      if (i.source !== undefined) {
        id = i.source;
        meta = sourceMeta(tx, id);
      } else {
        if (!i.url && !i.file) throw bad("url", "a URL or a file");
        const known = i.file ? undefined : knownUrl(tx, normUrl(i.url ?? ""));
        if (known) [id, meta] = known;
        else [id, meta] = [tx.id(1), sourceFor(i.url, i.file)];
      }
      const old = tx.get("spacesrc", `${s.id}:${id}`);
      if (old && !old.rm) throw refuse("PRECONDITION_FAILED", "The space already has this source.");
      const rv = s.srcPolicy === "review" && rankIn(tx, s.id, tx.me) < RANK.mod;
      tx.put({
        kind: "spacesrc",
        sp: s.id,
        src: id,
        by: tx.me,
        note: (i.note ?? "").trim(),
        rv,
        rm: false,
        meta,
        nurl: meta.url ? normUrl(meta.url) : null,
        createdAt: tx.now,
      });
      if (!tx.get("srcread", `${tx.me}:${id}`))
        tx.put({ kind: "srcread", u: tx.me, src: id, createdAt: tx.now });
      return { id, review: rv };
    },
  }),

  // Approve or reject a source waiting for review, remove one from the space
  // or restore it, or keep a reported one. Reject and keep resolve its
  // reports.
  defineMutator({
    name: "spaceSources.review",
    input: z.strictObject({
      space: ulidS,
      source: z.string().regex(SOURCE_ID),
      decision: z.enum(["approve", "reject", "remove", "restore", "keep"]),
    }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const e = tx.get("spacesrc", `${i.space}:${i.source}`);
      const match = e !== undefined && (i.decision === "restore" ? e.rm : !e.rm);
      if (match) {
        if (i.decision === "approve") tx.put({ ...e, rv: false });
        if (i.decision === "reject" || i.decision === "remove") tx.put({ ...e, rm: true });
        if (i.decision === "restore") tx.put({ ...e, rm: false });
      } else if (i.decision !== "keep")
        throw refuse("NOT_FOUND", "The space has no record of this source.");
      if (i.decision === "keep" || i.decision === "reject")
        for (const r of tx.scan("srcrep.sp", i.space))
          if (r.src === i.source) tx.del("srcrep", `${i.space}:${r.src}:${r.by}`);
      return null;
    },
  }),

  defineMutator({
    name: "spaceSources.setPolicy",
    input: z.strictObject({ space: ulidS, policy: spaces.sourcePolicySchema }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      tx.put({ ...needSpace(tx, i.space), srcPolicy: i.policy });
      return null;
    },
  }),

  // One report per person, source and space: a second one replaces the
  // first's reason.
  defineMutator({
    name: "sourceReports.create",
    input: z.strictObject({ space: ulidS, source: z.string().regex(SOURCE_ID), why: z.string() }),
    can: (tx, i) => inSpace(tx, i.space, "member"),
    run: (tx, i) => {
      needSpace(tx, i.space);
      sourceMeta(tx, i.source);
      tx.put({
        kind: "srcrep",
        sp: i.space,
        src: i.source,
        by: tx.me,
        why: i.why,
        createdAt: tx.now,
      });
      return null;
    },
  }),
];

/** A source with this normalized URL: Session's catalog first, then the
 * spaces' sources the actor may read. */
function knownUrl(tx: Tx, nurl: string): [string, SourceMeta] | undefined {
  if (!nurl) return undefined;
  const c = tx.scan("source.nurl", nurl)[0];
  if (c) return [c.id, c.meta];
  const e = tx.scan("spacesrc.nurl", nurl).find((x) => !x.rm && canRead(tx, x, tx.me));
  return e ? [e.src, e.meta] : undefined;
}
