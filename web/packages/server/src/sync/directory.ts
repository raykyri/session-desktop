// `spaces.directory` over the sync store (`01` C7, R5): the open channels of
// the `records` table in the order the server created them (`created_v`,
// then key), so a channel created during a walk of the pages comes after
// every page already read and is not skipped, whatever id its creator chose.
// A cursor is `<created_v>.<id>` of the last channel of a page.

import type { SqliteStore } from "@session/db";
import { channelName } from "@session/mutators";

import type { SpaceDirectory } from "../spaces/directory.js";

const CURSOR = /^(\d{1,15})\.([0-9A-Z]{26})$/;

export function storeDirectory(store: SqliteStore): SpaceDirectory {
  const page = store.sqlite.prepare<[number, number, string, number], { key: string; v: number }>(
    `SELECT key, created_v AS v FROM records
      WHERE kind = 'space' AND json_extract(body, '$.vis') = 'open'
        AND (created_v > ? OR (created_v = ? AND key > ?))
      ORDER BY created_v, key LIMIT ?`,
  );
  return {
    openSpaces: (after, limit) => {
      let v = -1;
      let key = "";
      if (after !== null) {
        const m = CURSOR.exec(after);
        // a cursor this directory did not make names no page
        if (!m) return [];
        v = Number(m[1]);
        key = `space:${m[2] ?? ""}`;
      }
      return page.all(v, v, key, limit).flatMap((row) => {
        const r = store.byKey(row.key);
        return r?.kind === "space" ? [{ space: r, cursor: `${row.v}.${r.id}` }] : [];
      });
    },
    byName: (raw) => {
      // the name as a channel address writes it: any case, with or without `#`
      const name = channelName(raw);
      const key = name === null ? undefined : store.uniqueKey("space.name", name);
      const r = key === undefined ? undefined : store.byKey(key);
      return r?.kind === "space" ? r : null;
    },
  };
}
