import type { PositionEntryOrder, StrategySignal, TradeSide } from "../types.js";

const POSITION_EPSILON = 1e-9;

function stopDistance(side: TradeSide, entryPrice: number, stopLoss: number): number {
  if (side === "long") {
    return entryPrice - stopLoss;
  }

  return stopLoss - entryPrice;
}

export function buildPlannedEntryOrders(
  signal: StrategySignal,
  defaultPositionSizeUsd: number,
): PositionEntryOrder[] {
  if (signal.maxRiskUsd !== undefined) {
    return signal.entryOrders.map((order) => {
      const riskFraction = order.riskFraction ?? order.sizeFraction ?? 0;
      const riskBudgetUsd = signal.maxRiskUsd! * riskFraction;
      const distanceToStop = stopDistance(signal.side, order.price, signal.stopLoss);
      const sizeUnits = distanceToStop <= POSITION_EPSILON ? 0 : riskBudgetUsd / distanceToStop;

      return {
        ...order,
        sizeUnits,
        riskBudgetUsd,
        status: "pending",
      };
    });
  }

  const positionSizeUsd = signal.positionSizeUsd ?? defaultPositionSizeUsd;
  const intendedSizeUnits = positionSizeUsd / signal.entryReferencePrice;
  return signal.entryOrders.map((order) => ({
    ...order,
    sizeUnits: intendedSizeUnits * (order.sizeFraction ?? order.riskFraction ?? 0),
    status: "pending",
  }));
}

export function calculatePlannedEntryNotionalUsd(entryOrders: PositionEntryOrder[]): number {
  return entryOrders.reduce((sum, order) => sum + order.sizeUnits * order.price, 0);
}
