// The small provider mark beside a model's label. The desktop keyed these off
// adapter ids (`lib/adapterIcons.ts`); the web has one registry, so the mark is
// derived from the model id. A family that ships no mark shows none; in a list
// the slot is still reserved (`reserve`) so every label starts on one column.

import claudeIcon from "../../assets/model-icons/claude-ai.svg";
import grokIcon from "../../assets/model-icons/grok.svg";
import openaiIcon from "../../assets/model-icons/openai.svg";

export function modelIconSrc(modelId: string): string | null {
  if (modelId.startsWith("claude")) return claudeIcon;
  if (modelId.startsWith("grok")) return grokIcon;
  if (modelId.startsWith("gpt")) return openaiIcon;
  return null;
}

export function ModelIcon({
  modelId,
  size = 13,
  reserve = false,
}: {
  modelId: string;
  size?: number;
  /** Keep the mark's width when there is no mark, for aligned rows. */
  reserve?: boolean;
}) {
  const src = modelIconSrc(modelId);
  if (!src) {
    return reserve ? (
      <span aria-hidden="true" className="inline-block shrink-0" style={{ width: size }} />
    ) : null;
  }
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
