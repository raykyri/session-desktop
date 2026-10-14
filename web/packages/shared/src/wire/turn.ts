// The durable transcript format: a run's answer is an ordered list of turns,
// each a list of blocks. Mirrors the desktop backend's `Turn`
// (src-tauri/src/transcript.rs). The web stores the same shape and fills
// `agentId` with the node id; it leaves the `native*` fields unset.

export type TurnBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id?: string | null; name: string; input: unknown }
  | { type: "toolResult"; toolUseId?: string | null; content: unknown; isError: boolean }
  | { type: "raw"; value: unknown };

export interface ThreadParticipant {
  kind: "user" | "assistant" | "session";
  actorId: string;
  adapter?: string | null;
  agentId?: string | null;
  label?: string | null;
}

export interface Turn {
  id: string;
  agentId: string;
  sessionId?: string | null;
  role: string;
  blocks: TurnBlock[];
  sourceIndex: number;
  /** Milliseconds since the Unix epoch when the native transcript recorded
   * this turn; absent for adapters or records without time data. */
  timestamp?: number | null;
  participant?: ThreadParticipant | null;
  status?: "superseded" | "interrupted" | "uncertain" | null;
  statusReason?: "codexRollback" | "interrupted" | "claudePromptBranch" | "unknownBranch" | null;
  /** Active model-context membership is independent from execution outcome. */
  contextStatus?: "rolledBack" | null;
  nativeId?: string | null;
  parentNativeId?: string | null;
  nativeMessageId?: string | null;
}

/** Identifies the message a fork branches from. Mirrors the adapters' anchor:
 * Claude keys off the uuid chain, Codex off the transcript line index. */
export interface MessageAnchor {
  nativeId?: string | null;
  parentNativeId?: string | null;
  sourceIndex: number;
}
