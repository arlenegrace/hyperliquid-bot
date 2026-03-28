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
