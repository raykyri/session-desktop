// The replica of a build without the fixtures (02 §9.1): a `SyncReplica`
// per viewer over the sync routes, with the tab's client id, drafts that
// come back on Discard (and the text of "Not sent" writes kept for a
// reload), the `UPGRADE_REQUIRED` reload, the connection status the shell
// reads, and a new read of the session when the cookie turns out to be
// another person's.

import { getMe, queryKeys } from "../api/account.js";
import { fetchDirectory, fetchSpaceByName } from "../api/spaces.js";
import { appQueryClient } from "../app/queryClient.js";
import { showToast } from "../features/shell/Toast.js";
import { viewerHandle, type Viewer } from "../features/shell/viewer.js";
import { useConnectionStore } from "../stores/connection.js";
import { useDraftsStore } from "../stores/drafts.js";

import type { ReplicaConfig } from "./ReplicaProvider.js";
import { HttpSyncTransport } from "./http.js";
import type { DraftRef } from "./source.js";
import { SyncReplica } from "./syncReplica.js";
import { keepTabClientId, tabClientId } from "./tabClient.js";
import { beforeUpgradeReload, upgradeRequired } from "./upgrade.js";

/** Put a write's text back in its composer unless the person has typed
 * something else there since. */
export function restoreDraft(draft: DraftRef): void {
  const drafts = useDraftsStore.getState();
  if (!drafts.get(draft.key)?.text.trim()) drafts.setDraft(draft.key, draft.text);
}

/** The handle the session is signed in as now, for the replica's check of
 * a new client id (`whoAmI`); null signed out or without a handle. */
export async function sessionHandle(): Promise<string | null> {
  const me = await getMe();
  return me && me.status === "active" ? me.handle : null;
}

export function liveReplicaConfig(
  o: { fetch?: typeof globalThis.fetch; whoAmI?: () => Promise<string | null> } = {},
): ReplicaConfig {
  const transport = new HttpSyncTransport({
    onUpgrade: () => upgradeRequired(),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    create: (viewer: Viewer) => {
      const member = viewer.kind === "member";
      return new SyncReplica({
        // a waiting account reads as signed out (01 R5): no user log, and
        // Home is every open channel
        me: member ? viewerHandle(viewer.user) : null,
        writer: member,
        userId: viewer.kind === "signedOut" ? null : viewer.user.id,
        transport,
        directory: fetchDirectory,
        byName: fetchSpaceByName,
        claim: (userId, register) => tabClientId(userId, register),
        keepClientId: (userId, clientId, lastSeq) =>
          void keepTabClientId(userId, clientId, lastSeq).catch(() => undefined),
        restoreDraft,
        unsentDrafts: {
          keep: (local, draft) => useDraftsStore.getState().keepUnsent(local, draft),
          drop: (local) => useDraftsStore.getState().dropUnsent(local),
        },
        whoAmI: o.whoAmI ?? sessionHandle,
        onSessionChanged: () => void appQueryClient.invalidateQueries({ queryKey: queryKeys.me() }),
        beforeReload: beforeUpgradeReload,
        onLeft: (name) => showToast(`You are no longer a member of #${name}.`),
        // the server's wording of a ban (`@session/mutators` `tx.ts`)
        onBanned: (name) => showToast(`You are banned from #${name}.`),
        onConnection: (status) => useConnectionStore.getState().setStatus(status),
      });
    },
  };
}
