// A person's own records: mutes, blocks, read sources, the profile and
// notifications. They act in no space.

import { spaces } from "@session/shared";
import { z } from "zod";

import { canRead, isClosed, rankIn, RANK } from "../access.js";
import { defineMutator, personal, type Tx } from "../engine.js";
import { refuse } from "../errors.js";
import { readable, text } from "../rules.js";
import { handleS, ulidS } from "../schemas.js";
import { sourceMeta } from "./threads.js";

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A person's `seen` record, as it is or new. */
const seenOf = (tx: Tx) => tx.get("seen", tx.me) ?? { kind: "seen" as const, u: tx.me, reqs: false, reps: false };

export const personalMutators = [
  // mute or unmute a person: Home leaves out their threads
  defineMutator({
    name: "mutes.set",
    input: z.strictObject({ handle: handleS, on: z.boolean() }),
    can: () => personal(),
    run: (tx, i) => {
      const has = tx.get("mute", `${tx.me}:${i.handle}`) !== undefined;
      if (i.on && !has) tx.put({ kind: "mute", u: tx.me, who: i.handle, createdAt: tx.now });
      if (!i.on && has) tx.del("mute", `${tx.me}:${i.handle}`);
      return { on: i.on };
    },
  }),

  // block or unblock a person: they can't reply to you or see your profile
  defineMutator({
    name: "blocks.set",
    input: z.strictObject({ handle: handleS, on: z.boolean() }),
    can: () => personal(),
    run: (tx, i) => {
      const has = tx.get("block", `${tx.me}:${i.handle}`) !== undefined;
      if (i.on && !has) tx.put({ kind: "block", u: tx.me, who: i.handle, createdAt: tx.now });
      if (!i.on && has) tx.del("block", `${tx.me}:${i.handle}`);
      return { on: i.on };
    },
  }),

  defineMutator({
    name: "sources.markRead",
    input: z.strictObject({ id: z.string().regex(SOURCE_ID) }),
    can: (tx, i) => {
      sourceMeta(tx, i.id);
      return personal();
    },
    run: (tx, i) => {
      if (!tx.get("srcread", `${tx.me}:${i.id}`))
        tx.put({ kind: "srcread", u: tx.me, src: i.id, createdAt: tx.now });
      return null;
    },
  }),

  defineMutator({
    name: "profile.update",
    input: spaces.spaceProfileSchema.strict(),
    can: () => personal(),
    run: (tx, i) => {
      tx.put({ kind: "profile", u: tx.me, name: text(i.name, "name"), bio: i.bio.trim() });
      return null;
    },
  }),

  defineMutator({
    name: "notifications.markRead",
    input: z.strictObject({ id: ulidS }),
    can: () => personal(),
    run: (tx, i) => {
      const n = readable(tx, "notif", i.id);
      if (!n.read) tx.put({ ...n, read: true });
      return null;
    },
  }),

  // Every notification the person may read, and the moderators' join-request
  // and report notices.
  defineMutator({
    name: "notifications.markAllRead",
    input: z.strictObject({}),
    can: () => personal(),
    run: (tx) => {
      for (const n of tx.scan("notif.to", tx.me))
        if (!n.read && canRead(tx, n, tx.me)) tx.put({ ...n, read: true });
      tx.put({ ...seenOf(tx), reqs: true, reps: true });
      return null;
    },
  }),

  // The join-requests or reports notice was read: the caller moderates a
  // space (a closed one, for requests).
  defineMutator({
    name: "notifications.markSeen",
    input: z.strictObject({ kind: z.enum(["requests", "reports"]) }),
    can: (tx, i) => {
      const mods = tx.scan("member.u", tx.me).some((m) => {
        if (rankIn(tx, m.sp, tx.me) < RANK.mod) return false;
        const s = tx.get("space", m.sp);
        return s !== undefined && !s.deleted && (i.kind === "reports" || isClosed(s));
      });
      if (!mods)
        throw refuse(
          "FORBIDDEN",
          `Only moderators get the ${i.kind === "requests" ? "join requests" : "reports"} notification.`,
        );
      return personal();
    },
    run: (tx, i) => {
      const s = seenOf(tx);
      tx.put(i.kind === "requests" ? { ...s, reqs: true } : { ...s, reps: true });
      return null;
    },
  }),
];
