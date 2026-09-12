import type { ThreadParticipant, Turn, TurnBlock } from "../types";

export function formatTurnsTranscript(turns: Turn[], assistantLabel: string) {
  return turns.map((turn) => formatTurnTranscript(turn, assistantLabel)).join("\n\n");
}

function formatTurnTranscript(turn: Turn, assistantLabel: string) {
  return [
    turnRoleLabel(turn.role, assistantLabel, turn.participant),
    ...turn.blocks.map(formatTurnBlockTranscript),
  ]
    .join("\n")
    .trimEnd();
}

function turnRoleLabel(
  role: string,
  assistantLabel: string,
  participant?: ThreadParticipant | null,
) {
  if (participant?.label) return participant.label;
  if (role === "assistant") return assistantLabel;
  if (role === "system") return "System";
  return role;
}

function formatTurnBlockTranscript(block: TurnBlock) {
  switch (block.type) {
    case "text":
      return block.text;
    case "toolUse":
      return formatLabeledBlock(block.name, block.input);
    case "toolResult":
      return formatLabeledBlock(block.isError ? "Tool error" : "Tool result", block.content);
    case "raw":
      return formatLabeledBlock("Raw", block.value);
  }
}

function formatLabeledBlock(label: string, value: unknown) {
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return content ? `${label}\n${content}` : label;
}
