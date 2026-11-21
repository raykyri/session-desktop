// `spaces.directory` (`01` C7, R5): the open channels, paged, and
// `spaces.byName`. Public: a signed-out reader and a waiting account read
// open channels and private channels' landings too (`04` I5). Limited per
// user or IP (`04` Z1): the directory 60 a minute, `byName` 30, each call of
// a tRPC batch counted.

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
});
