// Who is reading the feed, for its controls (02 §3.2, §9.3): whether the
// viewer can write, their handle in the replica, how a signed-out control
// opens sign-in, and the model and effort new asks run on.

import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";

import { useOnlineData, useReplica } from "../../replica/ReplicaProvider.js";
import { composerModel, stepDownEffort, type Effort } from "../../replica/online.js";
import { openAuthDialog } from "../auth/authDialog.js";
import { canWrite, type Viewer } from "../shell/viewer.js";

export interface FeedViewer {
  viewer: Viewer;
  /** An active account that may add to what it reads: asks, posts,
   * replies, joins. False inside a frozen channel (`FrozenChannel`). */
  writer: boolean;
  /** An active account, whatever the channel: it deletes its own items and
   * saves, which a frozen channel allows (04 B6). */
  active: boolean;
  /** The name of the frozen channel the controls are in, or null. */
  frozen: string | null;
  signedOut: boolean;
  /** The viewer's handle in the replica; null signed out. */
  me: string | null;
  /** Opens sign-in for a signed-out write control (02 §3.2). */
  signIn: () => void;
}

const FeedViewerContext = createContext<FeedViewer>({
  viewer: { kind: "signedOut" },
  writer: false,
  active: false,
  frozen: null,
  signedOut: true,
  me: null,
  signIn: () => {},
});

export function FeedViewerProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const source = useReplica();
  // A signed-out write control opens the auth dialog (02 W7.2, §9.5).
  const signIn = useCallback(() => openAuthDialog({ step: "landing" }), []);
  const value = useMemo(
    () => ({
      viewer,
      writer: canWrite(viewer),
      active: canWrite(viewer),
      frozen: null,
      signedOut: viewer.kind === "signedOut",
      me: source.me,
      signIn,
    }),
    [viewer, source, signIn],
  );
  return <FeedViewerContext.Provider value={value}>{children}</FeedViewerContext.Provider>;
}

export function useFeedViewer(): FeedViewer {
  return useContext(FeedViewerContext);
}

/** The controls of a thread in a frozen channel (04 B6, 02 W6.10): nothing
 * new can be added, and the viewer's own items keep Delete. */
export function FrozenChannel({ name, children }: { name: string; children: ReactNode }) {
  const outer = useFeedViewer();
  const value = useMemo(() => ({ ...outer, writer: false, frozen: name }), [outer, name]);
  return <FeedViewerContext.Provider value={value}>{children}</FeedViewerContext.Provider>;
}

/** The model and effort picked in this tab (02 §5): unset, the composer
 * starts on the site's defaults. */
interface ComposerChoice {
  model: string | null;
  effort: Effort | null;
  set: (choice: { model?: string; effort?: Effort }) => void;
}

export const useComposerChoice = create<ComposerChoice>()((set) => ({
  model: null,
  effort: null,
  set: (choice) => set(choice),
}));

/** The model and effort a new ask runs on: the tab's choice, else the
 * site's defaults, with the effort stepped down to one the model accepts. */
export function useRunChoice(): { model: string; effort: Effort } {
  const online = useOnlineData();
  const chosen = useComposerChoice();
  const model = composerModel(online, chosen.model);
  const effort = chosen.effort ?? online.defaultEffort;
  return {
    model: model?.id ?? online.defaultModel,
    effort: model ? stepDownEffort(effort, model.efforts) : effort,
  };
}
