import type { LadderLevelPlan, TradeSide } from "../src/types.js";

function createPriceSteps(startPrice: number, endPrice: number, levels: number): number[] {
  if (levels === 1) {
    return [startPrice];
  }

  const step = (endPrice - startPrice) / (levels - 1);
  return Array.from({ length: levels }, (_, index) => startPrice + step * index);
}

export function buildEqualLadder(
  labelPrefix: "Entry" | "Exit",
  startPrice: number,
  endPrice: number,
  levels: number,
): LadderLevelPlan[] {
  return createPriceSteps(startPrice, endPrice, levels).map((price, index) => ({
    label: `${labelPrefix} ${index + 1}`,
    price,
    sizeFraction: 1 / levels,
  }));
}

export const RECLAIM_ENTRY_LADDER_LEVELS = 2;
export const RECLAIM_ENTRY_BAND_PCT = 0.05;

export function buildRangeEntryOrders(
  side: TradeSide,
  edgeLow: number,
  edgeHigh: number,
  levels: number,
): LadderLevelPlan[] {
  return side === "long"
    ? buildEqualLadder("Entry", edgeHigh, edgeLow, levels)
    : buildEqualLadder("Entry", edgeLow, edgeHigh, levels);
}

/** Two equal entry legs: one at the range edge and one 5% of range width inward. */
export function buildReclaimEntryOrders(
  side: TradeSide,
  rangeLow: number,
  rangeHigh: number,
  rangeWidth: number,
): LadderLevelPlan[] {
  const bandOffset = rangeWidth * RECLAIM_ENTRY_BAND_PCT;
  return side === "long"
    ? buildRangeEntryOrders("long", rangeLow, rangeLow + bandOffset, RECLAIM_ENTRY_LADDER_LEVELS)
    : buildRangeEntryOrders("short", rangeHigh - bandOffset, rangeHigh, RECLAIM_ENTRY_LADDER_LEVELS);
}

export function buildRangeExitOrders(
  side: TradeSide,
  startPrice: number,
  endPrice: number,
  levels: number,
): LadderLevelPlan[] {
  return side === "long"
    ? buildEqualLadder("Exit", startPrice, endPrice, levels)
    : buildEqualLadder("Exit", startPrice, endPrice, levels);
}
