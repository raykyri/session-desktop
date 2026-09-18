// The small provider mark beside a model's label. The desktop keyed these off
// adapter ids (`lib/adapterIcons.ts`); the web has one registry, so the mark is
// derived from the model id and a model whose family ships no mark simply shows
// none rather than a placeholder glyph.

import claudeIcon from "../../assets/model-icons/claude-ai.svg";
import grokIcon from "../../assets/model-icons/grok.svg";
import openaiIcon from "../../assets/model-icons/openai.svg";

export function modelIconSrc(modelId: string): string | null {
  if (modelId.startsWith("claude")) return claudeIcon;
  if (modelId.startsWith("grok")) return grokIcon;
  if (modelId.startsWith("gpt")) return openaiIcon;
  return null;
}

export function ModelIcon({ modelId, size = 13 }: { modelId: string; size?: number }) {
  const src = modelIconSrc(modelId);
  if (!src) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="shrink-0"
    />
  );
}
