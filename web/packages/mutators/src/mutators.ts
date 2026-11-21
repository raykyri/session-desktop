// The mutator set (`01` U5): the procedure names of the contract
// (`spaces.spaceMutators`), one file per area. Input schemas are the
// contract's, strict: a field the schema does not list (`saves`, `u`,
// `createdAt`, `code`) is BAD_REQUEST, never stored. Ids are narrowed to
// ULIDs whose time fits 48 bits.

import { COMMENTS } from "./comments.js";
import { INVITES } from "./invites.js";
import { MEMBERS } from "./members.js";
import { MODERATION } from "./moderation.js";
import { NODES } from "./nodes.js";
import { NOTIFICATIONS } from "./notifications.js";
import { PREFS } from "./prefs.js";
import { REPLIES } from "./replies.js";
import { SAVES } from "./saves.js";
import { SPACES } from "./spaces.js";
import { THREADS } from "./threads.js";
import type { AnyMutator } from "./tx.js";

export const MUTATORS: Readonly<Record<string, AnyMutator>> = Object.freeze({
  ...SPACES,
  ...MEMBERS,
  ...THREADS,
  ...SAVES,
  ...NODES,
  ...REPLIES,
  ...COMMENTS,
  ...INVITES,
  ...MODERATION,
  ...NOTIFICATIONS,
  ...PREFS,
});

export const mutatorNames = Object.keys(MUTATORS);
