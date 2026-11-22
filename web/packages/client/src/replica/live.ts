// The replica of a build without the fixtures (02 §9.1): a `SyncReplica`
// per viewer over the sync routes, with the tab's client id, drafts that
// come back on Discard (and the text of "Not sent" writes kept for a
// reload), the `UPGRADE_REQUIRED` reload, the connection status the shell
// reads, and a new read of the session when the cookie turns out to be
// another person's.

import { bannedMessage } from "@session/mutators";

import { getMe, queryKeys } from "../api/account.js";
import { fetchDirectory, fetchSpaceByName, fetchThreadSpace } from "../api/spaces.js";
import { appQueryClient } from "../app/queryClient.js";
import { showToast } from "../features/shell/Toast.js";
import { viewerHandle, type Viewer } from "../features/shell/viewer.js";
import { useConnectionStore } from "../stores/connection.js";
import { useDraftsStore } from "../stores/drafts.js";
import { composerOfKey, useThreadUiStore } from "../stores/threadUi.js";

import type { ReplicaConfig } from "./ReplicaProvider.js";
import { HttpSyncTransport } from "./http.js";
import type { DraftRef } from "./source.js";
import { SyncReplica } from "./syncReplica.js";
import { keepTabClientId, tabClientId } from "./tabClient.js";
import { beforeUpgradeReload, upgradeRequired } from "./upgrade.js";

/** Put a write's text back in its composer unless the person has typed
 * something else there since. On Discard an inline composer (an ask, a
 * reply, a comment) also opens again at the row it was opened from, which
 * focuses it (02 §9.2: Discard "returns typed text to its composer"); the
 * new-thread composer is always open. */
export function restoreDraft(draft: DraftRef, how?: { discarded: boolean }): void {
  const drafts = useDraftsStore.getState();
  if (!drafts.get(draft.key)?.text.trim()) drafts.setDraft(draft.key, draft.text);
  if (!how?.discarded) return;
  const target = composerOfKey(draft.key);
  if (target) useThreadUiStore.getState().open(target.thread, target.composer, target.selected);
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
        threadSpace: fetchThreadSpace,
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
        onLeft: (name) => showToast(`You no longer have access to #${name}.`),
        // the server's wording of a ban (`@session/mutators` `tx.ts`)
        onBanned: (name, open) => showToast(bannedMessage(name, open)),
        onConnection: (status) => useConnectionStore.getState().setStatus(status),
      });
    },
  };
}
