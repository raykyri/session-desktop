// `spaces.directory` (`01` C7, R5): the open channels, paged, and
// `spaces.byName`. Public: a signed-out reader and a waiting account read
// open channels and private channels' landings too (`04` I5). Limited per
// user or IP (`04` Z1): the directory 60 a minute, `byName` 30, each call of
// a tRPC batch counted. `spaces.threadSpace` answers the channel of a thread
// the caller may read (a thread address on Home, All or Saved, `/?t=<id>`,
// whose channel log the replica does not hold), under the snapshots limit.
// A thread that does not exist and one the caller may not read answer the
// same `{ space: null }`.

import { ULID_RE, view } from "@session/mutators";
import type { Spaces } from "@session/shared";
import { z } from "zod";

import { directoryPage, type DirectoryPage } from "../../spaces/directory.js";
import { limit, publicProcedure, router } from "../base.js";

export const spacesRouter = router({
  directory: publicProcedure
    .use(limit("directory", "userOrIp"))
    .input(
      z
        .object({
          cursor: z.string().max(64).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }): DirectoryPage => directoryPage(ctx.directory, input ?? {})),
  /** The channel of a name; a private channel's record is its landing. */
  byName: publicProcedure
    .use(limit("byName", "userOrIp"))
    .input(z.object({ name: z.string().min(1).max(64) }))
    .query(({ ctx, input }): { space: Spaces.SpaceRecord | null } => ({
      space: ctx.directory.byName(input.name),
    })),
  /** The id of the channel a thread is in, when the caller may read the
   * thread now; a waiting account reads as signed out (`01` R5). */
  threadSpace: publicProcedure
    .use(limit("snapshots", "userOrIp"))
    .input(z.object({ thread: z.string().regex(ULID_RE) }))
    .query(({ ctx, input }): { space: string | null } => {
      const store = ctx.sync?.store;
      const r = store?.byKey(`thread:${input.thread}`);
      if (!store || r?.kind !== "thread") return { space: null };
      const reader = ctx.user?.status === "active" ? ctx.user.handle : null;
      return { space: view(store, r, reader) === null ? null : r.s };
    }),
});
