// `spaces.directory` (`01` C7, R5; `04` I5): the open channels, paged, for
// the All scope, Browse, a channel address the reader has not joined, and a
// signed-out reader's Home. Online-only; the channels' records are read
// through the sync routes. No page holds a private channel, whoever asks.
// `spaces.byName` answers one channel by its name, a private one's landing
// included, for a channel address (`/c/<name>`) the replica cannot resolve.

import type { Spaces } from "@session/shared";

type SpaceRec = Spaces.SpaceRecord;

/** The most channels on one page. */
export const DIRECTORY_PAGE_MAX = 200;

export interface DirectoryPage {
  spaces: SpaceRec[];
  /** The cursor of the next page; null on the last. */
  nextCursor: string | null;
}

/** Where the open channels are read from. */
export interface SpaceDirectory {
  /** Open channels by id, after the id `after` (exclusive), at most
   * `limit`. */
  openSpaces(after: string | null, limit: number): SpaceRec[];
  /** The channel of a name, open or private: a private channel's record is
   * its landing (name, About, owner, member count; `04` I5). */
  byName(name: string): SpaceRec | null;
}

/** No channels (a server without the sync store). */
export const EMPTY_DIRECTORY: SpaceDirectory = { openSpaces: () => [], byName: () => null };

/** One page of the directory, in id order (ULIDs: creation order). A
 * private channel is never served, whatever the directory returns. */
export function directoryPage(
  directory: SpaceDirectory,
  input: { cursor?: string | undefined; limit?: number | undefined },
): DirectoryPage {
  const limit = Math.min(Math.max(1, input.limit ?? DIRECTORY_PAGE_MAX), DIRECTORY_PAGE_MAX);
  // one more than the page, to know whether another follows
  const rows = directory.openSpaces(input.cursor ?? null, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    spaces: page.filter((s) => s.vis === "open"),
    nextCursor: rows.length > limit && last ? last.id : null,
  };
}
