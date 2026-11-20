// The state most screens start from: who is signed in, the spaces they may
// find and their role in each.

import { useMemo } from "react";

import { useMe, type Me } from "../api/account.js";
import { readsSpace, rolesOf, spacesOf, type Role, type Space } from "../data/spaces.js";
import { useDirectory, useRecords, useSession } from "../sync/react.js";
import type { SpacesSession } from "../sync/session.js";

export interface World {
  me: Me | null;
  session: SpacesSession | null;
  spaces: Space[];
  roles: Record<string, Role>;
  byId: Map<string, Space>;
  /** The directory has answered (or failed). */
  loaded: boolean;
  /** The directory's read failed. */
  failed: boolean;
}

export function useWorld(): World {
  const me = useMe().data ?? null;
  const session = useSession();
  const dir = useDirectory();
  const data = useRecords(
    (r) => ({ spaces: spacesOf(r, dir.data), roles: rolesOf(r) }),
    [dir.data],
  );
  const spaces = useMemo(() => data?.spaces ?? [], [data]);
  const byId = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);
  return {
    me,
    session,
    spaces,
    roles: data?.roles ?? {},
    byId,
    loaded: dir.status === "ready" || dir.status === "error",
    failed: dir.status === "error" && !dir.data,
  };
}

export const canRead = (w: World, s: Space) => readsSpace(s, w.roles[s.id]);
