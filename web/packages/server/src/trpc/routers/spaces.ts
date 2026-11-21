// `spaces.directory` (`01` C7, R5): the open channels, paged. Public: a
// signed-out reader and a waiting account read open channels too (`04` I5).

import { z } from "zod";

import { directoryPage, type DirectoryPage } from "../../spaces/directory.js";
import { publicProcedure, router } from "../base.js";

export const spacesRouter = router({
  directory: publicProcedure
    .input(
      z
        .object({
          cursor: z.string().max(64).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }): DirectoryPage => directoryPage(ctx.directory, input ?? {})),
});
