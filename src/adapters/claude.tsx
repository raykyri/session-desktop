import type { AgentUiAdapter } from ".";
import type { LauncherSelectOption } from "../components/LauncherSelect";

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

export const claudeUiAdapter: AgentUiAdapter = {
  id: CLAUDE_ADAPTER_ID,
  label: "Claude",
};
