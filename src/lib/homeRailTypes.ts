import type { AgentStatusTone } from "./appHelpers";

export interface HomeRailQueuedTurn {
  id: string;
  text: string;
  rawText: string;
  pauseAfter: boolean;
  waitForAgentId?: string | null;
  waitForLabel?: string | null;
  deliveryLabel?: string | null;
}

export interface HomeRailPastTurn {
  id: string;
  text: string;
  settledAt: number | null;
}

export interface HomeRailWorkstream {
  agentId: string;
  paneId: string;
  rootGroupId: string;
  title: string;
  statusTone: AgentStatusTone;
  statusClass: string;
  waitingOnPane: boolean;
  paused: boolean;
  latestUserTurn: string | null;
  currentStartedAt: number | null;
  currentSettledAt: number | null;
  pastTurns: HomeRailPastTurn[];
  hasEarlierPastTurns: boolean;
  loadingEarlierPastTurns: boolean;
  queuedTurns: HomeRailQueuedTurn[];
}

export interface HomeRailScrollPosition {
  top: number;
  stuck: boolean;
}
