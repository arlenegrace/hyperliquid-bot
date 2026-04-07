import type { PositionEntryOrder, StrategySignal, TradeSide } from "../types.js";

const POSITION_EPSILON = 1e-9;

/** When set, entry sizes are rounded to the exchange step size; leftover steps go to orders farthest from the opposite range edge (long: highest price first, short: lowest price first). */
export interface EntrySizeAllocationOptions {
  szDecimals: number;
}

/**
 * Splits total coin budget (positionSizeUsd / entryReferencePrice) across n orders in equal base steps,
 * then assigns any remainder steps to the highest-priority orders (long: highest limit price first;
 * short: lowest limit price first) so total size approaches the env budget without falling short from
 * independent per-order flooring.
 */
export function allocateEntryOrderSizeUnits({
  positionSizeUsd,
  entryReferencePrice,
  orderPrices,
  szDecimals,
  side,
}: {
  positionSizeUsd: number;
  entryReferencePrice: number;
  orderPrices: number[];
  szDecimals: number;
  side: TradeSide;
}): number[] {
  const n = orderPrices.length;
  if (n === 0) {
    return [];
  }

  const quantum = 10 ** -szDecimals;
  const totalUnits = positionSizeUsd / entryReferencePrice;
  const totalSteps = Math.floor(totalUnits / quantum + POSITION_EPSILON);
  if (totalSteps <= 0) {
    return orderPrices.map(() => 0);
  }

  const basePerOrder = Math.floor(totalSteps / n);
  const remainder = totalSteps - basePerOrder * n;

  const priorityIndices = orderPrices.map((_, index) => index);
  if (side === "long") {
    priorityIndices.sort((a, b) => (orderPrices[b] ?? 0) - (orderPrices[a] ?? 0));
  } else {
    priorityIndices.sort((a, b) => (orderPrices[a] ?? 0) - (orderPrices[b] ?? 0));
  }

  const steps = new Array<number>(n).fill(basePerOrder);
  for (let k = 0; k < remainder; k++) {
    const idx = priorityIndices[k];
    if (idx !== undefined) {
      steps[idx] += 1;
    }
  }

  return steps.map((s) => s * quantum);
}

function stopDistance(side: TradeSide, entryPrice: number, stopLoss: number): number {
  if (side === "long") {
    return entryPrice - stopLoss;
  }

  return stopLoss - entryPrice;
}

export function buildPlannedEntryOrders(
  signal: StrategySignal,
  defaultPositionSizeUsd: number,
  allocation?: EntrySizeAllocationOptions,
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

  if (allocation !== undefined) {
    const orderPrices = signal.entryOrders.map((order) => order.price);
    const sizeUnitsList = allocateEntryOrderSizeUnits({
      positionSizeUsd,
      entryReferencePrice: signal.entryReferencePrice,
      orderPrices,
      szDecimals: allocation.szDecimals,
      side: signal.side,
    });

    return signal.entryOrders.map((order, index) => ({
      ...order,
      sizeUnits: sizeUnitsList[index] ?? 0,
      status: "pending",
    }));
  }

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
