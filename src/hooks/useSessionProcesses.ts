import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setPreventSleep } from "../lib/api";
import { agentStatusKeepsMachineAwake, desiredPreventSleepState } from "../lib/appHelpers";
import type { AgentInfo, GroupInfo } from "../types";

/**
 * The backend's groups and agents as session events report them, and the
 * wake lock held while the `preventSleep` setting is on and an agent may
 * still be working.
 */
export function useSessionProcesses(preventSleep: boolean) {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // False while a fresh/reloaded WebContent document still holds the empty
  // placeholder above. Until listAgents() succeeds, it is not safe to infer
  // that the backend has no active agents and release its existing wake lock.
  const [agentsHydrated, setAgentsHydrated] = useState(false);
  /** Applies the startup agent list; the wake lock is decided from then on. */
  const hydrateAgents = useCallback((initial: AgentInfo[]) => {
    setAgents(initial);
    setAgentsHydrated(true);
  }, []);

  // Keep the machine awake while the toggle is on and at least one agent may
  // still be working, including while an in-flight tool waits for permission or
  // user feedback.
  // Releasing the lock once every agent is at rest lets normal power management
  // resume.
  const anyAgentBusy = useMemo(
    () => agents.some((agent) => agentStatusKeepsMachineAwake(agent.status)),
    [agents],
  );
  useEffect(() => {
    const active = desiredPreventSleepState(agentsHydrated, preventSleep, anyAgentBusy);
    if (active === null) {
      return;
    }
    void setPreventSleep(active).catch(() => undefined);
    if (!active) {
      return;
    }
    // Re-assert periodically while the lock is wanted: the backend declines (and
    // releases) it while on battery under 10%, so this lets a drop below — or a
    // recovery / plugging in — take effect without waiting for an agent state change.
    const interval = window.setInterval(() => {
      void setPreventSleep(true).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [agentsHydrated, preventSleep, anyAgentBusy]);

  return {
    groups,
    setGroups,
    groupsRef,
    agents,
    setAgents,
    hydrateAgents,
  };
}
