// The replica of a build without the fixtures (02 §9.1): a `SyncReplica`
// per viewer over the sync routes, with the tab's client id, drafts that
// come back on Discard, the `UPGRADE_REQUIRED` reload and the connection
// status the shell reads.

import { fetchDirectory, fetchSpaceByName } from "../api/spaces.js";
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

export function liveReplicaConfig(): ReplicaConfig {
  const transport = new HttpSyncTransport({ onUpgrade: () => upgradeRequired() });
  return {
    create: (viewer: Viewer) => {
      const member = viewer.kind === "member";
      return new SyncReplica({
        me: viewer.kind === "signedOut" ? null : viewerHandle(viewer.user),
        writer: member,
        userId: viewer.kind === "signedOut" ? null : viewer.user.id,
        transport,
        directory: fetchDirectory,
        byName: fetchSpaceByName,
        claim: (userId, register) => tabClientId(userId, register),
        keepClientId: (userId, clientId, lastSeq) =>
          void keepTabClientId(userId, clientId, lastSeq).catch(() => undefined),
        restoreDraft,
        beforeReload: beforeUpgradeReload,
        onLeft: (name) => showToast(`You are no longer a member of #${name}.`),
        onConnection: (status) => useConnectionStore.getState().setStatus(status),
      });
    },
  };
}
