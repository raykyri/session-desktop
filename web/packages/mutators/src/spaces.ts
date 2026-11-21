// Spaces ("channels" to users): create, About, join, leave (`01` C9, C11,
// C14, C18; `04` B1-B3, B6).

import { isClosed, isOwnerOf, roleIn } from "./access.js";
import { refuse } from "./errors.js";
import { memberKey } from "./records.js";
import { M, addMember, bad, needSpace, refreshSpace, ulidS } from "./rules.js";
import { isoToMs } from "./time.js";
import { define } from "./tx.js";
import { channelName } from "./validate.js";

export const SPACES = {
  // Space names are unique across all spaces, private ones included (kept
  // as decided; review round 1, R10): the CONFLICT on create tells anyone
  // that a name is taken, so a private space's name can be probed. It names
  // only the name sent.
  "spaces.create": define({
    input: M["spaces.create"].input.extend({ id: ulidS }).strict(),
    online: true,
    who: "user",
    intent: "none",
    ids: (i) => [i.id],
    run: (tx, i) => {
      const name = channelName(i.name);
      if (name === null) throw bad("name", "a channel name: a-z, 0-9 and -, 2 to 30 characters");
      if (tx.unique("space.name", name)) throw refuse("CONFLICT", `#${name} already exists.`);
      tx.create({
        kind: "space",
        id: i.id,
        name,
        desc: (i.desc ?? "").trim(),
        vis: i.vis ?? "open",
        members: 1,
        owner: tx.me,
        frozen: false,
        createdAt: tx.now,
      });
      tx.put({ kind: "stats", sp: i.id, posts: 0, updatedAt: tx.now });
      addMember(tx, i.id, tx.me, "owner", tx.id(1));
      return { id: i.id };
    },
  }),

  // About only (`01` C11); name and visibility are set at creation
  "spaces.update": define({
    input: M["spaces.update"].input.extend({ id: ulidS }).strict(),
    who: "owner",
    intent: "none",
    space: (_tx, i) => i.id,
    run: (tx, i) => {
      const s = needSpace(tx, i.id);
      tx.put({ ...s, desc: i.desc.trim() });
      return null;
    },
  }),

  "spaces.join": define({
    input: M["spaces.join"].input.extend({ space: ulidS }).strict(),
    who: "user",
    intent: "none",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (roleIn(tx, s.id, tx.me)) return;
      if (!isClosed(s)) return;
      // DESIGN (phase 0 finding): the mock also admits a person whose join
      // request was approved. Here approval makes the member record directly
      // (joinRequests.decide, prototype only), and an approved request
      // admits nobody: kept as a standing pass, it would let a removed
      // member join again.
      if (i.invite === undefined)
        throw refuse("FORBIDDEN", `#${s.name} is private: joining it needs an invite link.`);
      const link = tx.unique("invite.code", i.invite);
      // a link is made by the owner, who keeps the right to make links; it
      // works once, until it expires (checked now, at apply time)
      const live =
        link !== undefined &&
        link.sp === s.id &&
        link.dead === null &&
        isoToMs(link.expiresAt) > isoToMs(tx.now);
      if (!live) throw refuse("FORBIDDEN", "This invite link has expired or was already used.");
    },
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (roleIn(tx, s.id, tx.me)) return null;
      if (isClosed(s) && i.invite !== undefined) {
        const link = tx.unique("invite.code", i.invite);
        if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });
      }
      addMember(tx, s.id, tx.me, "member", tx.id(1));
      refreshSpace(tx, s.id);
      return null;
    },
  }),

  // the owner cannot leave (`01` C18); anyone may leave a frozen space
  "spaces.leave": define({
    input: M["spaces.leave"].input.extend({ space: ulidS }).strict(),
    who: "member",
    intent: "none",
    frozen: "allowed",
    space: (_tx, i) => i.space,
    can: (tx, i) => {
      if (isOwnerOf(tx, i.space, tx.me))
        throw refuse("PRECONDITION_FAILED", "You own this channel: the owner can’t leave it.");
    },
    run: (tx, i) => {
      if (!tx.byKey(memberKey(i.space, tx.me))) return null;
      tx.del(memberKey(i.space, tx.me));
      refreshSpace(tx, i.space);
      return null;
    },
  }),
};
