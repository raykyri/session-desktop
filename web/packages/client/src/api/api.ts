// Desktop-named wrappers over the tRPC procedures (07 §1). The desktop's
// `src/lib/api.ts` was one of the two seams against Rust; keeping its function
// names means the ported views call the same thing they always called.
//
// STUB. Every call throws until the transport lands; the signatures are the
// contract from `03-api-and-events.md`.

import type {
  ResearchTreeDetail,
  ResearchTreeSummary,
  User,
  UserSettings,
  Workspace,
} from "@session/shared";

import { notWired } from "./notWired.js";

export function getMe(): Promise<User | null> {
  return notWired("auth.me");
}

export function getSettings(): Promise<UserSettings> {
  return notWired("settings.get");
}

export function updateSettings(settings: Partial<UserSettings>): Promise<UserSettings> {
  return notWired("settings.update", settings);
}

export function listWorkspaces(): Promise<Workspace[]> {
  return notWired("workspaces.list");
}

export function listResearchTrees(input: {
  workspaceId: string;
  includeArchived: boolean;
}): Promise<ResearchTreeSummary[]> {
  return notWired("research.listTrees", input);
}

export function getResearchTree(treeId: string): Promise<ResearchTreeDetail> {
  return notWired("research.getTree", treeId);
}

export function createResearchTree(input: {
  workspaceId: string;
  prompt: string;
  model: string;
  documentIds?: string[];
}): Promise<ResearchTreeDetail> {
  return notWired("research.createTree", input);
}

/** The sign-in entry point. A real redirect, not a fetch: the OAuth handshake
 * has to leave the SPA, so this is the one call that works before the
 * transport exists. */
export function startGitHubSignIn(): void {
  window.location.assign("/auth/github");
}
