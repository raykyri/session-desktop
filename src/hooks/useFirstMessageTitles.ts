import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { CODEX_ADAPTER_ID } from "../adapters/codex";
import { openRouterChatCompletion, renamePane } from "../lib/api";
import { defaultPaneTitle } from "../lib/appHelpers";
import {
  advancePendingFirstMessageTitle,
  firstMessageTitleConfig,
  summarizeFirstMessageTitle,
  type OpenRouterTitleConfig,
  type PendingFirstMessageTitle,
} from "../lib/openRouterTitles";
import type { AppSettings } from "../lib/settings";
import type { AgentInfo, PaneInfo, RuntimeConfig } from "../types";

interface FirstMessageTitleOptions {
  panes: PaneInfo[];
  agents: AgentInfo[];
  config: RuntimeConfig | null;
  settings: AppSettings;
  setPanes: Dispatch<SetStateAction<PaneInfo[]>>;
  onToast: (message: string, tone?: "normal" | "warning") => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Titles the pane of a Codex agent launched from a shell (for example in a
 * pane created through the control socket) after the agent's first prompt,
 * when OpenRouter title generation is configured. A title the user set is
 * never replaced. The returned handlers are stable, for the event
 * subscription that captures them once.
 */
export function useFirstMessageTitles(options: FirstMessageTitleOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pendingByAgentRef = useRef(new Map<string, PendingFirstMessageTitle>());
  // Panes this hook titled; a later generated title must not replace them.
  const generatedTitlePaneIdsRef = useRef(new Set<string>());

  const paneHasUserSetTitle = useCallback((pane: PaneInfo, agent: AgentInfo | undefined) => {
    if (generatedTitlePaneIdsRef.current.has(pane.id)) {
      return true;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, optionsRef.current.config);
    return defaultTitle !== null && pane.title !== defaultTitle;
  }, []);

  // The pane may have been reassigned to another agent while the title was
  // being generated.
  const paneStillBelongsToAgent = (
    pane: PaneInfo,
    agent: AgentInfo | undefined,
    expectedAgentId: string,
  ) => agent?.id === expectedAgentId || pane.agentId === expectedAgentId;

  const applyFirstMessageTitle = useCallback(
    async (
      paneId: string,
      sourceMessage: string,
      titleConfig: OpenRouterTitleConfig,
      expectedAgentId: string,
    ) => {
      const titleablePane = () => {
        const { panes, agents } = optionsRef.current;
        const pane = panes.find((candidate) => candidate.id === paneId);
        const paneAgent = pane ? agents.find((agent) => agent.paneId === pane.id) : undefined;
        if (pane && !paneStillBelongsToAgent(pane, paneAgent, expectedAgentId)) {
          return { pane, titleable: false };
        }
        return { pane, titleable: !pane || !paneHasUserSetTitle(pane, paneAgent) };
      };
      if (!titleablePane().titleable) {
        return;
      }

      let title: string | null;
      try {
        title = await summarizeFirstMessageTitle(sourceMessage, titleConfig, openRouterChatCompletion);
      } catch (err) {
        optionsRef.current.onToast(`OpenRouter title error: ${errorMessage(err)}`, "warning");
        return;
      }
      if (!title) {
        return;
      }

      const current = titleablePane();
      if (!current.pane || !current.titleable) {
        return;
      }

      try {
        const updated = await renamePane(paneId, title);
        generatedTitlePaneIdsRef.current.add(paneId);
        optionsRef.current.setPanes((panes) =>
          panes.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
        );
      } catch (err) {
        optionsRef.current.onToast(`Couldn't set terminal title: ${errorMessage(err)}`, "warning");
      }
    },
    [paneHasUserSetTitle],
  );

  const handleAgentSpawned = useCallback(
    (agent: AgentInfo, paneId: string | null, source: string | null) => {
      if (source !== "shell" || agent.adapter !== CODEX_ADAPTER_ID) {
        return;
      }
      const resolvedPaneId = paneId ?? agent.paneId ?? null;
      if (!resolvedPaneId || pendingByAgentRef.current.has(agent.id)) {
        return;
      }
      const pane = optionsRef.current.panes.find((candidate) => candidate.id === resolvedPaneId);
      if (pane && paneHasUserSetTitle(pane, agent)) {
        return;
      }
      pendingByAgentRef.current.set(agent.id, { paneId: resolvedPaneId, checkedMessages: 0 });
    },
    [paneHasUserSetTitle],
  );

  const handleAgentPromptSubmitted = useCallback(
    (agentId: string, prompt: string) => {
      const pending = pendingByAgentRef.current.get(agentId);
      if (!pending) {
        return;
      }
      const titleConfig = firstMessageTitleConfig(optionsRef.current.settings);
      const step = advancePendingFirstMessageTitle(pending, prompt, titleConfig);
      if (step.pending) {
        pendingByAgentRef.current.set(agentId, step.pending);
      } else {
        pendingByAgentRef.current.delete(agentId);
      }
      if (step.sourceMessage && titleConfig) {
        void applyFirstMessageTitle(pending.paneId, step.sourceMessage, titleConfig, agentId);
      }
    },
    [applyFirstMessageTitle],
  );

  // Forget panes and agents that no longer exist.
  const { panes, agents } = options;
  useEffect(() => {
    const ids = new Set(panes.map((pane) => pane.id));
    for (const paneId of generatedTitlePaneIdsRef.current) {
      if (!ids.has(paneId)) {
        generatedTitlePaneIdsRef.current.delete(paneId);
      }
    }
    for (const [agentId, pending] of pendingByAgentRef.current) {
      if (!ids.has(pending.paneId)) {
        pendingByAgentRef.current.delete(agentId);
      }
    }
  }, [panes]);
  useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    for (const agentId of pendingByAgentRef.current.keys()) {
      if (!ids.has(agentId)) {
        pendingByAgentRef.current.delete(agentId);
      }
    }
  }, [agents]);

  return { handleAgentSpawned, handleAgentPromptSubmitted };
}
