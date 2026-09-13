import type { AgentUiAdapter, ComposerPolicy } from ".";
import type { LauncherSelectOption } from "../components/LauncherSelect";
import { normalizeClaudeTurns } from "./claudeTurns";

// Mirrors CLAUDE_EFFORT_LEVELS in src-tauri/src/adapters/claude.rs. Every
// current Claude model supports the full range.
export const CLAUDE_EFFORT_OPTIONS: LauncherSelectOption[] = [
  { value: "", label: "Default effort" },
  { value: "low", label: "Low effort", dividerBefore: true },
  { value: "medium", label: "Medium effort" },
  { value: "high", label: "High effort" },
  { value: "xhigh", label: "Extra effort" },
  { value: "max", label: "Max effort" },
  { value: "ultracode", label: "Ultracode effort" },
];

export const CLAUDE_ADAPTER_ID = "claude";

const claudeComposerPolicy: ComposerPolicy = {
  readyStatuses: ["awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "running", "awaitingPermission"],
  steerStatuses: ["starting", "running"],
  permissionActions: [
    { id: "approve", label: "Approve", input: "y" },
    { id: "deny", label: "Deny", input: "n" },
  ],
};

export const claudeUiAdapter: AgentUiAdapter = {
  id: CLAUDE_ADAPTER_ID,
  label: "Claude",
  normalizeTurns: normalizeClaudeTurns,
  composerPolicy: () => claudeComposerPolicy,
  supportsFork: true,
  supportsForkAtMessage: true,
};
