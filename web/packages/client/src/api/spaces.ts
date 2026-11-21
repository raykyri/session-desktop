// `spaces.directory` (01 C7, R5; 04 I5): the open channels, for the All
// scope, Browse, the channel address of a channel the viewer has not joined,
// and the signed-out reader's Home; `spaces.byName`: one channel by name, a
// private channel's landing included. Online-only; the replica reads each
// channel's records through the sync routes.

import type { SpaceRec } from "@session/mutators";

import { trpc } from "./trpc.js";

/** The most pages the client reads (200 channels each). */
const MAX_PAGES = 10;

export async function fetchDirectory(): Promise<SpaceRec[]> {
  const out: SpaceRec[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: { spaces: SpaceRec[]; nextCursor: string | null } =
      await trpc().spaces.directory.query(cursor === null ? {} : { cursor });
    out.push(...r.spaces);
    cursor = r.nextCursor;
    if (cursor === null) break;
  }
  return out;
}

export async function fetchSpaceByName(name: string): Promise<SpaceRec | null> {
  return (await trpc().spaces.byName.query({ name })).space;
}

/** `spaces.threadSpace`: the id of the channel a thread is in, null when
 * there is no such thread or the viewer may not read it. */
export async function fetchThreadSpace(thread: string): Promise<string | null> {
  return (await trpc().spaces.threadSpace.query({ thread })).space;
}
