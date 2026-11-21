// Members: the owner removes, bans and unbans anyone but themselves (`01`
// C18; `04` B2, §6.4).

import { banKey, memberKey } from "./records.js";
import { M, actsOn, refreshSpace, stale, ulidS } from "./rules.js";
import { define } from "./tx.js";
import { handleS } from "./validate.js";

export const MEMBERS = {
  // `base.adm`: the member's admission id as the owner saw it. A removal
  // queued before the person was removed and let in again is STALE (review
  // round 1, R1b); the person cannot change the id alone, except by joining
  // an open space again (review round 2, finding 2). A person who is no
  // longer a member: nothing to remove.
  "members.remove": define({
    input: M["members.remove"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    intent: "base.adm",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.user),
    run: (tx, i) => {
      const m = tx.byKey(memberKey(i.space, i.user));
      if (m?.kind !== "member") return null;
      if (m.adm !== i.base.adm) throw stale();
      tx.del(memberKey(i.space, i.user));
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // A ban applies to the person as they are now, a member or not: it carries
  // no base (review round 2, finding 2). A new ban writes a moderation log
  // entry (`01` C12).
  "members.ban": define({
    input: M["members.ban"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    intent: "as is",
    space: (_tx, i) => i.space,
    can: (tx, i) => actsOn(tx, i.user),
    run: (tx, i) => {
      // the ban's id is the mock's (`<space>:<user>`): one ban per person and
      // space, outside the ULID id registry
      if (tx.byKey(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));
      if (!tx.byKey(banKey(i.space, i.user))) {
        tx.put({
          kind: "ban",
          id: `${i.space}:${i.user}`,
          sp: i.space,
          u: i.user,
          createdAt: tx.now,
        });
        tx.create({
          kind: "modlog",
          id: tx.id(1),
          sp: i.space,
          act: "ban",
          item: null,
          by: tx.me,
          author: i.user,
          note: null,
          createdAt: tx.now,
        });
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  "members.unban": define({
    input: M["members.unban"].input.extend({ space: ulidS, user: handleS }).strict(),
    who: "owner",
    intent: "as is",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      if (!tx.byKey(banKey(i.space, i.user))) return null;
      tx.del(banKey(i.space, i.user));
      tx.create({
        kind: "modlog",
        id: tx.id(1),
        sp: i.space,
        act: "unban",
        item: null,
        by: tx.me,
        author: i.user,
        note: null,
        createdAt: tx.now,
      });
      return null;
    },
  }),
};
