// `spaces.directory` over the sync store (`01` C7, R5): the open channels of
// the `records` table, by key.

import type { SqliteStore } from "@session/db";
import type { Spaces } from "@session/shared";

import type { SpaceDirectory } from "../spaces/directory.js";

export function storeDirectory(store: SqliteStore): SpaceDirectory {
  const page = store.sqlite.prepare<[string, number], { key: string }>(
    `SELECT key FROM records
      WHERE kind = 'space' AND key > ? AND json_extract(body, '$.vis') = 'open'
      ORDER BY key LIMIT ?`,
  );
  return {
    openSpaces: (after, limit) =>
      page
        .all(after === null ? "space:" : `space:${after}`, limit)
        .map((row) => store.byKey(row.key))
        .filter((r): r is Spaces.SpaceRecord => r?.kind === "space"),
  };
}
