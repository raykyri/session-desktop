import type { AgentUiAdapter, ComposerPolicy } from ".";
import type { LauncherSelectOption } from "../components/LauncherSelect";

// Mirrors CODEX_REASONING_EFFORT_LEVELS in src-tauri/src/adapters/codex.rs.
export const CODEX_REASONING_OPTIONS: LauncherSelectOption[] = [
  { value: "", label: "Default reasoning" },
  { value: "low", label: "Low reasoning", dividerBefore: true },
  { value: "medium", label: "Medium reasoning" },
  { value: "high", label: "High reasoning" },
  { value: "xhigh", label: "Extra high reasoning" },
  { value: "max", label: "Max reasoning" },
  { value: "ultra", label: "Ultra reasoning" },
];

export const CODEX_ADAPTER_ID = "codex";

const codexComposerPolicy: ComposerPolicy = {
  readyStatuses: ["awaitingInput", "done", "idle"],
  queueStatuses: ["starting", "running", "awaitingPermission"],
  steerStatuses: ["starting", "running"],
  permissionActions: [],
};

export const codexUiAdapter: AgentUiAdapter = {
  id: CODEX_ADAPTER_ID,
  label: "Codex",
  composerPolicy: () => codexComposerPolicy,
  supportsFork: true,
  supportsForkAtMessage: true,
};
