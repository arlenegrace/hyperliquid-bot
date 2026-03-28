import type { NetPositionSnapshot, PaperPosition, TradeSide } from "./types.js";

const POSITION_EPSILON = 1e-9;

function stopDistanceForSide(side: TradeSide, entryPrice: number, stopLoss: number): number {
  if (side === "long") {
    return Math.max(0, entryPrice - stopLoss);
  }

  return Math.max(0, stopLoss - entryPrice);
}

export function calculateWorstCaseLossUsd(
  side: TradeSide,
  entryPrice: number,
  stopLoss: number,
  sizeUnits: number,
): number {
  return stopDistanceForSide(side, entryPrice, stopLoss) * sizeUnits;
}

export function calculatePositionStopRiskUsd(position: PaperPosition): number {
  const filledRiskUsd =
    position.averageEntryPrice === undefined
      ? 0
      : calculateWorstCaseLossUsd(
          position.side,
          position.averageEntryPrice,
          position.stopLoss,
          position.remainingSizeUnits,
        );

  const pendingRiskUsd = position.entryOrders
    .filter((order) => order.status === "pending")
    .reduce(
      (sum, order) => sum + calculateWorstCaseLossUsd(position.side, order.price, position.stopLoss, order.sizeUnits),
      0,
    );

  return filledRiskUsd + pendingRiskUsd;
}

export function sumPositionStopRiskUsd(positions: PaperPosition[]): number {
  return positions.reduce((sum, position) => sum + calculatePositionStopRiskUsd(position), 0);
}

export function getNetPositionSnapshot(positions: PaperPosition[]): NetPositionSnapshot | undefined {
  const signedUnits = positions.reduce((sum, position) => {
    if (position.status !== "open" || position.remainingSizeUnits <= POSITION_EPSILON) {
      return sum;
    }

    return position.side === "long" ? sum + position.remainingSizeUnits : sum - position.remainingSizeUnits;
  }, 0);

  if (Math.abs(signedUnits) <= POSITION_EPSILON) {
    return undefined;
  }

  return {
    side: signedUnits > 0 ? "long" : "short",
    sizeUnits: Math.abs(signedUnits),
  };
}

export function isFlipSignal(side: TradeSide, positions: PaperPosition[]): boolean {
  const netPosition = getNetPositionSnapshot(positions);
  return netPosition !== undefined && netPosition.side !== side;
}

export function calculateSignalRiskBudgetUsd(
  side: TradeSide,
  positions: PaperPosition[],
  maxRiskUsd: number,
): number {
  if (isFlipSignal(side, positions)) {
    return maxRiskUsd;
  }

  return Math.max(0, maxRiskUsd - sumPositionStopRiskUsd(positions));
}
