import type { PaperPosition, TradeSide } from "./types.js";

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
