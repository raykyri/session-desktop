import type { AgentInfo } from "../types";

// The agent's thread id, mirroring the backend's fallback (agent_thread_id in
// thread_graph.rs): the stored value when present, else the synthetic
// `thread-{agentId}` the backend keys graph records by for agents that never
// got an explicit thread. Kept untrimmed so lookups match the backend's keys.
export function threadIdForAgent(agent: AgentInfo): string {
  return agent.threadId && agent.threadId.trim() ? agent.threadId : `thread-${agent.id}`;
}
