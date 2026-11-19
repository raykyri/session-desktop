// Spaces: create, settings, join, leave, the domain check, archive, delete,
// and the welcome page's first joins.

import { spaces } from "@session/shared";
import { z } from "zod";

import { bannedFrom, isClosed, roleIn } from "../access.js";
import { defineMutator, inSpace, inSpaces, personal, type Tx } from "../engine.js";
import { bad, notFound, refuse } from "../errors.js";
import type { InviteRec, SpaceRec } from "../records.js";
import {
  addMember,
  mayInvite,
  needSpace,
  normQs,
  normRules,
  refreshSpace,
  slug,
} from "../rules.js";
import { count, ulidS } from "../schemas.js";
import { msOf } from "../time.js";

/** Whether an invite link admits to `s` now. DESIGN (phase 0 finding): a
 * link carries its maker's authority, so it works only while the maker may
 * make links (checked now). A link that stopped working because its maker
 * lost that right works again once the maker has it again. */
function liveLink(tx: Tx, s: SpaceRec, link: InviteRec | undefined): boolean {
  return (
    link !== undefined &&
    link.sp === s.id &&
    link.dead === null &&
    link.revokedAt === null &&
    (link.expiresAt === null || msOf(link.expiresAt) > tx.nowMs) &&
    mayInvite(tx, s, link.by)
  );
}

/** The invite link of the invite notification a join names, when the join
 * names no code; null otherwise. A link that no longer exists stands as one
 * that does not admit. */
function noteLink(
  tx: Tx,
  i: { notification?: string | undefined; invite?: string | undefined },
): InviteRec | undefined | null {
  if (i.notification === undefined || i.invite !== undefined) return null;
  const n = tx.get("notif", i.notification);
  if (!n || n.to !== tx.me || n.type !== "invite" || n.invite === null) return null;
  return tx.get("invite", n.invite);
}

/** The settings `spaces.update` changes. `dom` is the domain check's (server
 * made) and `pages` the page procedures', so neither is a setting here; an
 * admin may still unset `dom` (remove a verified domain), which sets no
 * server-made value. */
const SETTINGS = [
  "name",
  "title",
  "av",
  "img",
  "desc",
  "rules",
  "vis",
  "policy",
  "qs",
  "invite",
  "faq",
  "topics",
  "postsOff",
  "plain",
  "pageEdit",
] as const;

const settingsS = spaces.spaceSettingsSchema
  .pick(
    Object.fromEntries(SETTINGS.map((k) => [k, true])) as Record<(typeof SETTINGS)[number], true>,
  )
  .strict();

/** What `unset` puts back: the value a new space has. */
const UNSET: Partial<Record<(typeof SETTINGS)[number], unknown>> = {
  av: 3,
  img: false,
  desc: "",
  rules: [],
  vis: "open",
  policy: null,
  qs: [],
  invite: null,
  faq: false,
  topics: [],
  postsOff: false,
  plain: false,
  pageEdit: null,
};

const unsetS = z.enum([
  "av",
  "img",
  "desc",
  "rules",
  "vis",
  "policy",
  "qs",
  "invite",
  "faq",
  "topics",
  "postsOff",
  "plain",
  "pageEdit",
  "dom",
]);

/** Space names are unique across all spaces, unlisted ones included (kept as
 * decided in review round 1, R10): the CONFLICT on create tells anyone that
 * a name is taken. It names only the name sent. */
function nameTaken(tx: Tx, name: string, except: string | null): boolean {
  return tx.scan("space.name", name).some((s) => s.id !== except);
}

export const spaceMutators = [
  defineMutator({
    name: "spaces.create",
    input: spaces.createSpaceInputSchema.extend({ id: ulidS }).strict(),
    online: true,
    ids: (i) => [i.id],
    can: () => personal(),
    run: (tx, i) => {
      const name = slug(i.name);
      if (!name) throw bad("name", "a name");
      if (nameTaken(tx, name, null)) throw refuse("CONFLICT", `#${name} already exists.`);
      const vis = i.vis ?? "open";
      const closed = vis !== "open";
      const rules = normRules(i.rules ?? []);
      tx.create({
        kind: "space",
        id: i.id,
        name,
        title: name,
        desc: (i.desc ?? "").trim() || "No description yet.",
        rules: rules.length ? rules : ["Be specific in asks."],
        rulesRev: 0,
        rulesPrev: [],
        rulesBy: null,
        vis,
        policy: closed ? (i.policy ?? "request") : null,
        invite: closed ? (i.invite ?? "mods") : null,
        qs: closed ? normQs(i.qs ?? []) : [],
        postsOff: false,
        av: 3,
        img: false,
        faq: i.faq === true,
        topics: [],
        plain: false,
        pageEdit: null,
        srcPolicy: "members",
        dom: null,
        archived: null,
        deleted: false,
        members: 1,
        mods: [[tx.me, "owner"]],
        createdAt: tx.now,
      });
      tx.put({ kind: "stats", sp: i.id, posts: 0, updatedAt: tx.now });
      addMember(tx, i.id, tx.me, "owner", tx.id(1));
      return { id: i.id };
    },
  }),

  defineMutator({
    name: "spaces.update",
    input: z.strictObject({
      id: ulidS,
      set: settingsS.optional(),
      unset: z.array(unsetS).optional(),
      base: z.strictObject({ rulesRev: count }).optional(),
      force: z.boolean().optional(),
    }),
    can: (tx, i) => inSpace(tx, i.id, "admin"),
    run: (tx, i) => {
      const s0 = needSpace(tx, i.id);
      const was: Record<string, unknown> = { ...s0 };
      for (const k of i.unset ?? []) was[k] = k === "dom" ? null : UNSET[k];
      const s1 = was as unknown as SpaceRec;
      const set = i.set ?? {};
      let name = s0.name;
      if (set.name !== undefined) {
        name = slug(set.name);
        if (!name) throw bad("set.name", "a name");
        if (name !== s0.name && nameTaken(tx, name, s0.id))
          throw refuse("CONFLICT", `#${name} already exists.`);
      }
      const rules = set.rules ? normRules(set.rules) : s1.rules;
      const rulesChange = rules.join("\n") !== s0.rules.join("\n");
      if (rulesChange && i.base && !i.force && i.base.rulesRev !== s0.rulesRev)
        throw refuse("CONFLICT", "Someone else changed the rules first.");
      const vis = set.vis ?? s1.vis;
      const closed = vis !== "open";
      const topics = set.topics ?? s1.topics;
      tx.put({
        ...s0,
        name,
        title: set.title ?? s1.title,
        desc: set.desc ?? s1.desc,
        rules,
        rulesRev: s0.rulesRev + (rulesChange ? 1 : 0),
        rulesPrev: rulesChange ? s0.rules : s0.rulesPrev,
        rulesBy: rulesChange ? tx.me : s0.rulesBy,
        vis,
        policy: closed ? (set.policy ?? s1.policy ?? "request") : null,
        invite: closed ? (set.invite ?? s1.invite ?? "mods") : null,
        qs: closed ? (set.qs ? normQs(set.qs) : s1.qs) : [],
        postsOff: set.postsOff ?? s1.postsOff,
        av: set.av ?? s1.av,
        img: set.img ?? s1.img,
        faq: set.faq ?? s1.faq,
        topics,
        plain: set.plain ?? s1.plain,
        pageEdit: set.pageEdit ?? s1.pageEdit,
        dom: s1.dom,
      });
      // threads in topics that no longer exist move to Other
      if (set.topics || i.unset?.includes("topics"))
        for (const p of tx.scan("thread.s", s0.id))
          if (p.topic !== null && !topics.some((x) => x[0] === p.topic))
            tx.put({ ...p, topic: null });
      // a closed space that becomes open: the open requests are approved
      if (isClosed(s0) && !closed) {
        let k = 0;
        for (const r of tx.scan("request.sp", s0.id)) {
          if (r.st !== "open") continue;
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          k++;
          if (!bannedFrom(tx, s0.id, r.u)) addMember(tx, s0.id, r.u, "member", tx.id(k));
        }
        refreshSpace(tx, s0.id);
      }
      return null;
    },
  }),

  defineMutator({
    name: "spaces.join",
    input: z.strictObject({
      space: ulidS,
      invite: z.string().optional(),
      notification: ulidS.optional(),
    }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "user");
      const s = needSpace(tx, i.space);
      if (i.notification !== undefined) {
        const n = tx.get("notif", i.notification);
        if (!n || n.to !== tx.me) throw notFound();
        if (n.type !== "invite" || n.sp !== s.id)
          throw refuse("FORBIDDEN", "This notification isn’t an invite to this space.");
      }
      if (roleIn(tx, s.id, tx.me)) return scope;
      if (!isClosed(s)) return scope;
      // an invite notification carries its link (phase 1b, Part 0 item 1):
      // joining from it uses that link, which must be live as a code would
      const viaNote = noteLink(tx, i);
      if (viaNote !== null) {
        if (!liveLink(tx, s, viaNote))
          throw refuse("FORBIDDEN", "This invite link has expired or was already used.");
        return scope;
      }
      // DESIGN (phase 0 finding): the mock also admits a person whose join
      // request was approved, or who has an invite notification. Here
      // approval makes the member record directly (joinRequests.decide), and
      // an invite is a link: an approved request or a notification, kept as
      // a standing pass, would let a removed member join again.
      if (i.invite === undefined)
        throw refuse(
          "FORBIDDEN",
          `#${s.name} is closed: joining it needs an invite or a request a moderator approved.`,
        );
      const link = tx.scan("invite.code", i.invite)[0];
      if (!liveLink(tx, s, link))
        throw refuse("FORBIDDEN", "This invite link has expired or was already used.");
      return scope;
    },
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (i.notification !== undefined) {
        const n = tx.get("notif", i.notification);
        if (n) tx.put({ ...n, read: true, response: "accepted" });
      }
      if (roleIn(tx, s.id, tx.me)) return null;
      if (isClosed(s)) {
        const viaNote = noteLink(tx, i);
        const link =
          viaNote ?? (i.invite !== undefined ? tx.scan("invite.code", i.invite)[0] : undefined);
        if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });
      }
      addMember(tx, s.id, tx.me, "member", tx.id(1));
      refreshSpace(tx, s.id);
      return null;
    },
  }),

  defineMutator({
    name: "spaces.leave",
    input: z.strictObject({ space: ulidS }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "member");
      const sole =
        roleIn(tx, i.space, tx.me) === "owner" &&
        !tx.scan("member.sp", i.space).some((m) => m.role === "owner" && m.u !== tx.me);
      if (sole)
        throw refuse(
          "PRECONDITION_FAILED",
          "You are the only owner of this space. Transfer ownership before you leave.",
        );
      return scope;
    },
    run: (tx, i) => {
      if (!tx.get("member", `${i.space}:${tx.me}`)) return null;
      tx.del("member", `${i.space}:${tx.me}`);
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // The space's dom is "checking" until the check job writes "ok" (with
  // verifiedAt) or "failed".
  defineMutator({
    name: "spaces.verifyDomain",
    input: z.strictObject({ id: ulidS, domain: z.string(), method: z.literal("dns").optional() }),
    can: (tx, i) => inSpace(tx, i.id, "admin"),
    run: (tx, i) => {
      const domain = i.domain.trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
        throw bad("domain", "a domain such as example.com");
      const s = needSpace(tx, i.id);
      tx.put({
        ...s,
        dom: { domain, method: i.method ?? "dns", state: "checking", verifiedAt: null },
      });
      return null;
    },
    effects: (i) => [{ type: "job", kind: "domain", id: i.id }],
  }),

  // Archived: read-only, hidden from browse and search. The mock stores the
  // day as the page shows it (an `Intl` date); this stores the time.
  defineMutator({
    name: "spaces.archive",
    input: z.strictObject({ id: ulidS, archived: z.boolean() }),
    can: (tx, i) => inSpace(tx, i.id, "owner"),
    run: (tx, i) => {
      const s = needSpace(tx, i.id);
      tx.put({ ...s, archived: i.archived ? { by: tx.me, at: tx.now } : null });
      return null;
    },
  }),

  // Deleting a space erases its content for everyone: its threads and
  // everything under them, the likes and saves of them, its members,
  // requests, bans, invite links, reports, pages, skills, sources and the
  // notifications about it. The space record stays, marked deleted, so its
  // name stays taken and every later write in it is NOT_FOUND. The mock only
  // marks the space deleted.
  defineMutator({
    name: "spaces.delete",
    input: z.strictObject({ id: ulidS }),
    online: true,
    can: (tx, i) => inSpace(tx, i.id, "owner"),
    run: (tx, i) => {
      const s = needSpace(tx, i.id);
      eraseSpace(tx, s.id);
      tx.put({ ...s, deleted: true, archived: null, members: 0, mods: [] });
      return null;
    },
  }),

  // The welcome page's first spaces: open spaces only. The mock replaces the
  // person's list of joined spaces; this joins the listed ones and leaves
  // nothing.
  defineMutator({
    name: "onboarding.finish",
    input: z.strictObject({ spaces: z.array(ulidS).max(100) }),
    can: (tx, i) => {
      for (const id of i.spaces)
        if (isClosed(needSpace(tx, id)))
          throw refuse("FORBIDDEN", "The welcome page joins open spaces only.");
      return inSpaces(tx, i.spaces, "user");
    },
    run: (tx, i) => {
      let k = 0;
      for (const id of [...new Set(i.spaces)]) {
        if (roleIn(tx, id, tx.me)) continue;
        k++;
        addMember(tx, id, tx.me, "member", tx.id(k));
        refreshSpace(tx, id);
      }
      return null;
    },
  }),
];

/** Every record of a space but the space record, and the person's records
 * that point at its threads or are about it. */
function eraseSpace(tx: Tx, sp: string): void {
  for (const p of tx.scan("thread.s", sp)) {
    for (const x of tx.scan("followup.th", p.id)) tx.del("followup", x.id);
    for (const x of tx.scan("reply.th", p.id)) tx.del("reply", x.id);
    for (const x of tx.scan("run.th", p.id)) tx.del("run", x.id);
    for (const x of tx.scan("like.th", p.id)) tx.del("like", `${x.u}:${x.th}`);
    for (const x of tx.scan("save.th", p.id)) tx.del("save", `${x.u}:${x.th}`);
    for (const x of tx.scan("rlike.th", p.id)) tx.del("rlike", `${x.u}:${x.reply}`);
    for (const x of tx.scan("asksave.th", p.id)) tx.del("asksave", `${x.u}:${x.th}:${x.node}`);
    tx.del("counts", p.id);
    tx.del("thread", p.id);
  }
  for (const x of tx.scan("member.sp", sp)) tx.del("member", `${sp}:${x.u}`);
  for (const x of tx.scan("request.sp", sp)) tx.del("request", `${sp}:${x.u}`);
  for (const x of tx.scan("ban.sp", sp)) tx.del("ban", `${sp}:${x.u}`);
  for (const x of tx.scan("invite.sp", sp)) tx.del("invite", x.id);
  for (const x of tx.scan("report.sp", sp)) tx.del("report", x.id);
  for (const x of tx.scan("page.sp", sp)) tx.del("page", x.id);
  for (const x of tx.scan("spacesrc.sp", sp)) tx.del("spacesrc", `${sp}:${x.src}`);
  for (const x of tx.scan("srcrep.sp", sp)) tx.del("srcrep", `${sp}:${x.src}:${x.by}`);
  for (const x of tx.scan("invask.sp", sp)) tx.del("invask", `${x.u}:${sp}`);
  for (const x of tx.scan("notif.sp", sp)) tx.del("notif", x.id);
  for (const x of tx.scan("hide.s", sp)) tx.del("hide", x.item);
  for (const x of tx.scan("skill.sp", sp)) tx.del("skill", x.id);
  tx.del("pages", sp);
  tx.del("skills", sp);
  tx.del("stats", sp);
}
