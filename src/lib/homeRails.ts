import type { HomeRailPastTurn } from "./homeRailTypes";
import type { HomeTurnSummary } from "../types";
import { stripTaggedInstructionBlocksForPreview } from "./taggedInstructions";

export function railPastTurnSummaries(summaries: HomeTurnSummary[]): HomeRailPastTurn[] {
  return summaries.flatMap((summary) => {
    const text = stripTaggedInstructionBlocksForPreview(summary.text).trim();
    return text
      ? [{ id: summary.id, text, settledAt: summary.settledAt }]
      : [];
  });
}

export function mergeRailPastTurns(
  historical: HomeRailPastTurn[],
  recent: HomeRailPastTurn[],
): HomeRailPastTurn[] {
  const recentById = new Map(recent.map((turn) => [turn.id, turn]));
  const historicalIds = new Set(historical.map((turn) => turn.id));
  return [
    ...historical.map((turn) => recentById.get(turn.id) ?? turn),
    ...recent.filter((turn) => !historicalIds.has(turn.id)),
  ];
}
