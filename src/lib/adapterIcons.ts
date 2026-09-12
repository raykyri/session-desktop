import antigravityModelIconUrl from "../assets/model-icons/antigravity.svg";
import claudeModelIconUrl from "../assets/model-icons/claude-ai.svg";
import openAiModelIconUrl from "../assets/model-icons/openai.svg";
import grokModelIconUrl from "../assets/model-icons/grok.svg";
import { ANTIGRAVITY_ADAPTER_ID } from "../adapters/antigravity";
import { CLAUDE_ADAPTER_ID } from "../adapters/claude";
import { CODEX_ADAPTER_ID } from "../adapters/codex";
import { GROK_ADAPTER_ID } from "../adapters/grok";

/* Adapter icons for LauncherSelect chips — shared by the Home launcher and the
   new-research composer so every agent picker renders the same marks. */
export const ADAPTER_ICON_BY_ID: Record<string, string> = {
  [CLAUDE_ADAPTER_ID]: claudeModelIconUrl,
  [CODEX_ADAPTER_ID]: openAiModelIconUrl,
  [GROK_ADAPTER_ID]: grokModelIconUrl,
  [ANTIGRAVITY_ADAPTER_ID]: antigravityModelIconUrl,
};

// Codex's mark is dark-on-transparent, so invert it for the launcher's dark surface.
export function adapterIconClassName(adapterId: string): string | undefined {
  if (adapterId === CODEX_ADAPTER_ID) {
    return "is-mono-light";
  }
  return undefined;
}
