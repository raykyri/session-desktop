import { claudeUiAdapter } from "./claude";
import { codexUiAdapter } from "./codex";
import { grokUiAdapter } from "./grok";

export interface AgentUiAdapter {
  id: string;
  label: string;
}

const agentUiAdapters = [
  claudeUiAdapter,
  codexUiAdapter,
  grokUiAdapter,
];

export function findAgentUiAdapter(adapterId: string | null | undefined): AgentUiAdapter | null {
  return agentUiAdapters.find((adapter) => adapter.id === adapterId) ?? null;
}
