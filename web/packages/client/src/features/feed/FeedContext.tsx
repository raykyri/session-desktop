// Who is reading the feed, for its controls (02 §3.2, §9.3): whether the
// viewer can write, their handle in the replica, how a signed-out control
// opens sign-in, and the model and effort new asks run on.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";

import { useOnlineData, useReplica } from "../../replica/ReplicaProvider.js";
import { stepDownEffort, type Effort } from "../../replica/online.js";
import { canWrite, type Viewer } from "../shell/viewer.js";

export interface FeedViewer {
  viewer: Viewer;
  /** An active account: asks, posts, replies, saves, joins. */
  writer: boolean;
  signedOut: boolean;
  /** The viewer's handle in the replica; null signed out. */
  me: string | null;
  /** Opens sign-in for a signed-out write control (02 §3.2). */
  signIn: () => void;
}

const FeedViewerContext = createContext<FeedViewer>({
  viewer: { kind: "signedOut" },
  writer: false,
  signedOut: true,
  me: null,
  signIn: () => {},
});

export function FeedViewerProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const source = useReplica();
  // Sign-in is the `/login` page until the auth dialog (02 W7.2, M6).
  const signIn = useCallback(() => {
    void navigate({ to: "/login", search: { redirect: href } });
  }, [navigate, href]);
  const value = useMemo(
    () => ({
      viewer,
      writer: canWrite(viewer),
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
  const model =
    online.models.find((m) => m.id === (chosen.model ?? online.defaultModel)) ?? online.models[0];
  const effort = chosen.effort ?? online.defaultEffort;
  return {
    model: model?.id ?? online.defaultModel,
    effort: model ? stepDownEffort(effort, model.efforts) : effort,
  };
}
