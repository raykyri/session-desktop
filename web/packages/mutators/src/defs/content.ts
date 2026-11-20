// A space's skills and pages, and the sources added to it.
//
// Skills and pages have ids (phase 1a.2, decision 3): an edit, a removal and
// a move name an id, so a write that waited in an outbox acts on the item it
// named whatever moved meanwhile. Each skill is its own record with an id in
// `ID_KINDS` (phase 1b, Part 0 item 5), so the id registry vouches for a new
// skill's id; the space's `skills` record holds their order. A reorder sends
// the whole order with the order record's rev as `base`, and is STALE when a
// skill was added, removed or moved since (an edit does not change the
// order). A skill's and a page's version (`rev` of a skill, `ver` of a page
// document) counts its saves; an editor sends the version it opened as
// `base`, and the save is CONFLICT when someone saved since, unless `force`
// (the mock's edit conflicts, step 9). A page's title is unique in its space
// by its slug: a new page or a new title whose slug is taken is CONFLICT.

import { spaces } from "@session/shared";
import { z } from "zod";

import { RANK, canRead, rankIn, reviewedFor, roleIn } from "../access.js";
import { defineMutator, inSpace, type Tx } from "../engine.js";
import { bad, refuse, stale } from "../errors.js";
import type { PageEntry, PageRec, SkillRec, SkillsRec, SourceMeta } from "../records.js";
import { needSpace, text, writable } from "../rules.js";
import { baseS, count, ulidS } from "../schemas.js";

import { sourceMeta } from "./threads.js";

const changed = (base: number | undefined, current: number, force: boolean | undefined) =>
  !force && base !== undefined && base !== current;

// ---- skills ----

function orderOf(tx: Tx, sp: string): SkillsRec {
  needSpace(tx, sp);
  return tx.get("skills", sp) ?? { kind: "skills", sp, order: [], rev: 0 };
}

const noSkill = () => refuse("NOT_FOUND", "The server has no record of this skill.");

/** A skill of space `sp`, or NOT_FOUND. */
function skillIn(tx: Tx, sp: string, id: string): SkillRec {
  needSpace(tx, sp);
  const s = tx.get("skill", id);
  if (!s || s.sp !== sp) throw noSkill();
  return s;
}

const nameTaken = (tx: Tx, sp: string, name: string, except: string | null) =>
  tx.scan("skill.sp", sp).some((x) => x.id !== except && x.name === name);

// ---- pages ----

/** A page's key part: its title in lower case, runs of other characters as "-". */
export const pageSlug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The space's page list. */
function pagesOf(tx: Tx, sp: string): PageEntry[] {
  needSpace(tx, sp);
  return tx.get("pages", sp)?.list ?? [];
}

const noPage = () =>
  refuse("NOT_FOUND", "The server has no record of this page. Someone may have deleted it.");

function pageIn(tx: Tx, sp: string, id: string): PageEntry {
  const pg = pagesOf(tx, sp).find((p) => p.id === id);
  if (!pg) throw noPage();
  return pg;
}

/** A page title's slug, which no other page of the space has: BAD_REQUEST
 * for a title without a letter or a digit, CONFLICT for a taken one. */
function freeSlug(tx: Tx, sp: string, title: string, except: string | null): string {
  const slug = pageSlug(title);
  if (!slug) throw bad("title", "a title with a letter or a digit");
  if (pagesOf(tx, sp).some((p) => p.id !== except && pageSlug(p.t) === slug))
    throw refuse("CONFLICT", "The space has a page with this title.");
  return slug;
}

/** A page's document, or the empty one a listed page without a stored
 * document stands for (the mock takes its author and history from the
 * client's `base`; a write never stores client-made history here). */
function docOf(tx: Tx, sp: string, pg: PageEntry): Omit<PageRec, "rev"> {
  const d = tx.get("page", pg.id);
  if (d) return d;
  return {
    kind: "page",
    id: pg.id,
    sp,
    slug: pageSlug(pg.t),
    t: pg.t,
    text: [""],
    by: tx.me,
    ed: null,
    ver: 0,
    revs: [],
  };
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

/** Text without a lone surrogate (UTF-16 that is well formed). */
const wellFormed = z
  .string()
  .refine(
    (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s),
    {
      message: "expected text without a lone surrogate",
    },
  );

export const contentMutators = [
  defineMutator({
    name: "skills.create",
    input: z.strictObject({ id: ulidS, space: ulidS, name: z.string(), prompt: z.string() }),
    ids: (i) => [i.id],
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const o = orderOf(tx, i.space);
      if (nameTaken(tx, i.space, i.name, null))
        throw refuse("CONFLICT", `The space has a skill named ${i.name}.`);
      tx.create({ kind: "skill", id: i.id, sp: i.space, name: i.name, prompt: i.prompt, ver: 0 });
      tx.put({ ...o, order: [...o.order, i.id] });
      return { id: i.id };
    },
  }),

  defineMutator({
    name: "skills.update",
    input: z.strictObject({
      space: ulidS,
      id: ulidS,
      name: z.string(),
      prompt: z.string(),
      base: baseS.optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const row = skillIn(tx, i.space, i.id);
      if (changed(i.base?.rev, row.ver, i.force))
        throw refuse("CONFLICT", "Someone else changed this skill first.");
      if (nameTaken(tx, i.space, i.name, i.id))
        throw refuse("CONFLICT", `The space has a skill named ${i.name}.`);
      tx.put({ ...row, name: i.name, prompt: i.prompt, ver: row.ver + 1 });
      return null;
    },
  }),

  defineMutator({
    name: "skills.remove",
    input: z.strictObject({ space: ulidS, id: ulidS }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      skillIn(tx, i.space, i.id);
      const o = orderOf(tx, i.space);
      tx.del("skill", i.id);
      tx.put({ ...o, order: o.order.filter((x) => x !== i.id) });
      return null;
    },
  }),

  // The whole order, by id, with the list's rev as the moderator saw it:
  // STALE when the list changed since (a skill added, removed, edited or
  // moved); BAD_REQUEST when `order` is not the list's ids.
  defineMutator({
    name: "skills.reorder",
    input: z.strictObject({ space: ulidS, order: z.array(ulidS).max(500), base: baseS }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const o = orderOf(tx, i.space);
      if (o.rev !== i.base.rev)
        throw stale(tx, tx.me, o.rev === 0 ? null : o, [`skills:${i.space}`]);
      const ids = new Set(o.order);
      if (
        i.order.length !== ids.size ||
        new Set(i.order).size !== ids.size ||
        i.order.some((id) => !ids.has(id))
      )
        throw bad("order", "every skill of the space once");
      tx.put({ ...o, order: [...i.order] });
      return null;
    },
  }),

  // Add a page (`page` null, with a new `id`) or edit one (`page`: its id).
  defineMutator({
    name: "pages.update",
    input: z
      .strictObject({
        space: ulidS,
        page: ulidS.nullable().optional(),
        id: ulidS.optional(),
        title: z.string(),
        text: z.array(z.string()),
        base: pageBaseS.optional(),
        force: z.boolean().optional(),
      })
      .refine((i) => (i.page ?? null) !== null || i.id !== undefined, {
        path: ["id"],
        message: "expected the new page's id",
      }),
    ids: (i) => ((i.page ?? null) === null && i.id ? [i.id] : []),
    can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const title = text(i.title, "title");
      const body = i.text.length ? i.text : [""];
      const list = pagesOf(tx, i.space);
      if (i.page === null || i.page === undefined) {
        const id = i.id as string;
        const slug = freeSlug(tx, i.space, title, null);
        tx.create({
          kind: "page",
          id,
          sp: i.space,
          slug,
          t: title,
          text: body,
          by: tx.me,
          ed: tx.me,
          ver: 1,
          revs: [{ by: tx.me, note: "Created the page", createdAt: tx.now }],
        });
        tx.put({ kind: "pages", sp: i.space, list: [...list, { id, t: title, at: tx.now }] });
        return { id };
      }
      const pg = pageIn(tx, i.space, i.page);
      const doc = docOf(tx, i.space, pg);
      if (changed(i.base?.rev, doc.ver, i.force))
        throw refuse("CONFLICT", "Someone else changed this page first.");
      const slug = freeSlug(tx, i.space, title, pg.id);
      tx.put({
        kind: "pages",
        sp: i.space,
        list: list.map((p) => (p.id === pg.id ? { id: p.id, t: title, at: tx.now } : p)),
      });
      tx.put({
        kind: "page",
        id: pg.id,
        sp: i.space,
        slug,
        t: title,
        text: body,
        by: doc.by,
        ed: tx.me,
        ver: doc.ver + 1,
        revs: [{ by: tx.me, note: "Edited the page", createdAt: tx.now }, ...doc.revs],
      });
      return { id: pg.id };
    },
  }),

  // Restore an earlier version: the history keeps both (`note`: the history
  // line, written by the page; `rev`: the version's index in the history).
  defineMutator({
    name: "pages.restore",
    input: z.strictObject({
      space: ulidS,
      page: ulidS,
      rev: count,
      note: z.string(),
      base: pageBaseS.optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const doc = docOf(tx, i.space, pageIn(tx, i.space, i.page));
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
    input: z.strictObject({ space: ulidS, page: ulidS }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const pg = pageIn(tx, i.space, i.page);
      const list = pagesOf(tx, i.space).filter((p) => p.id !== pg.id);
      tx.put({ kind: "pages", sp: i.space, list });
      tx.del("page", pg.id);
      return null;
    },
  }),

  // Move a page, by id, to position `to` of the list (0 is the first;
  // About's up and down). The position is absolute, as a skills reorder's
  // order is, so the same move applied twice leaves the list as once (review
  // round 1 of phase 2, 2b design finding 5).
  defineMutator({
    name: "pages.move",
    input: z.strictObject({ space: ulidS, page: ulidS, to: count }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      const a = pageIn(tx, i.space, i.page);
      const rest = pagesOf(tx, i.space).filter((p) => p.id !== a.id);
      if (i.to > rest.length) throw bad("to", `a position from 0 to ${rest.length}`);
      tx.put({ kind: "pages", sp: i.space, list: [...rest.slice(0, i.to), a, ...rest.slice(i.to)] });
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
      // a URL and a file name are encoded (encodeURIComponent), which a lone
      // surrogate makes throw: refused by the schema (review round 1 of
      // phase 1, W7b)
      url: wellFormed.optional(),
      file: wellFormed.optional(),
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
      // a source a moderator removed is put back by a moderator only, not by
      // its maker or another member (review round 2 of phase 1)
      if (old?.rm && rankIn(tx, s.id, tx.me) < RANK.mod)
        throw refuse(
          "FORBIDDEN",
          "A moderator removed this source; only a moderator can add it again.",
        );
      // a source another person added and a moderator removed is added anew,
      // as the actor's: a record keeps its maker (review round 1 of phase 1,
      // W7a)
      if (old && old.by !== tx.me) tx.del("spacesrc", `${s.id}:${id}`);
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
      // a source of this space, as the actor reads it (review round 1 of
      // phase 1, E12f)
      const e = tx.get("spacesrc", `${i.space}:${i.source}`);
      if (!e || e.rm || !canRead(tx, e, tx.me))
        throw refuse("NOT_FOUND", "The space has no record of this source.");
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
  const e = tx
    .scan("spacesrc.nurl", nurl)
    .find((x) => !x.rm && canRead(tx, x, tx.me) && reviewedFor(tx, x, tx.me));
  return e ? [e.src, e.meta] : undefined;
}
