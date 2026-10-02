import type { ReactNode } from "react";
import { claudeUiAdapter } from "./claude";
import { codexUiAdapter } from "./codex";
import { grokUiAdapter } from "./grok";
import type { AgentInfo, PaneInfo, Turn, TurnBlock } from "../types";

export type AgentStatus = AgentInfo["status"];

interface PermissionAction {
  id: string;
  label: string;
  input: string;
}

export interface ComposerPolicy {
  readyStatuses: AgentStatus[];
  queueStatuses: AgentStatus[];
  steerStatuses: AgentStatus[];
  permissionActions: PermissionAction[];
}

export interface AgentUiAdapter {
  id: string;
  label: string;
  normalizeTurns?: (turns: Turn[]) => Turn[];
  renderBlock?: (block: TurnBlock, role: string) => ReactNode | null;
  composerPolicy: (agent: AgentInfo) => ComposerPolicy;
  supportsFork?: boolean;
  supportsForkAtMessage?: boolean;
  canFork?: (agent: AgentInfo) => boolean;
  contextRows?: (agent: AgentInfo, pane: PaneInfo) => Array<{ label: string; value: string }>;
}

const agentUiAdapters = [
  claudeUiAdapter,
  codexUiAdapter,
  grokUiAdapter,
];

export function findAgentUiAdapter(adapterId: string | null | undefined): AgentUiAdapter | null {
  return agentUiAdapters.find((adapter) => adapter.id === adapterId) ?? null;
}

export function getAgentUiAdapter(adapterId: string | null | undefined): AgentUiAdapter {
  return findAgentUiAdapter(adapterId) ?? claudeUiAdapter;
}
