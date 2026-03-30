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

interface ExitOrderTargetOptions {
  totalSizeUnits: number;
  exitPrices: number[];
  sizeDecimals: number;
  minOrderNotionalUsd: number;
}

function allocateEvenSizeSteps(totalSizeSteps: number, orderCount: number): number[] {
  const baseStepsPerOrder = Math.floor(totalSizeSteps / orderCount);
  const leftoverSteps = totalSizeSteps - baseStepsPerOrder * orderCount;

  return Array.from({ length: orderCount }, (_, index) =>
    index === 0 ? baseStepsPerOrder + leftoverSteps : baseStepsPerOrder,
  );
}

export function allocatePrioritizedExitOrderTargets({
  totalSizeUnits,
  exitPrices,
  sizeDecimals,
  minOrderNotionalUsd,
}: ExitOrderTargetOptions): number[] {
  if (exitPrices.length === 0 || totalSizeUnits <= POSITION_EPSILON) {
    return exitPrices.map(() => 0);
  }

  const sizeFactor = 10 ** sizeDecimals;
  const totalSizeSteps = Math.max(0, Math.round(totalSizeUnits * sizeFactor));
  if (totalSizeSteps === 0) {
    return exitPrices.map(() => 0);
  }

  const maxCandidateOrders = Math.min(exitPrices.length, totalSizeSteps);
  for (let activeOrderCount = maxCandidateOrders; activeOrderCount >= 1; activeOrderCount -= 1) {
    const allocatedSteps = allocateEvenSizeSteps(totalSizeSteps, activeOrderCount);
    const meetsMinimumNotional = allocatedSteps.every((sizeSteps, index) => {
      const sizeUnits = sizeSteps / sizeFactor;
      return sizeUnits > POSITION_EPSILON && sizeUnits * exitPrices[index]! + POSITION_EPSILON >= minOrderNotionalUsd;
    });

    if (!meetsMinimumNotional) {
      continue;
    }

    return exitPrices.map((_, index) => (index < activeOrderCount ? allocatedSteps[index]! / sizeFactor : 0));
  }

  return exitPrices.map(() => 0);
}
