import type { PositionEntryOrder, StrategySignal, TradeSide } from "../types.js";

const POSITION_EPSILON = 1e-9;

/** When set, entry sizes are rounded to the exchange step size; leftover steps go to the highest-remainder orders, with price priority used as a tie-breaker (long: highest price first, short: lowest price first). */
export interface EntrySizeAllocationOptions {
  szDecimals: number;
}

/**
 * Splits the USD budget across ladder orders using their weighted average limit price, floors each
 * order independently to the exchange step size, then adds back any affordable remainder steps in a
 * stable priority order so the final ladder never exceeds the USD budget.
 */
export function allocateEntryOrderSizeUnits({
  positionSizeUsd,
  orderPrices,
  orderSizeFractions,
  szDecimals,
  side,
}: {
  positionSizeUsd: number;
  orderPrices: number[];
  orderSizeFractions: number[];
  szDecimals: number;
  side: TradeSide;
}): number[] {
  const n = orderPrices.length;
  if (n === 0 || positionSizeUsd <= POSITION_EPSILON) {
    return [];
  }

  const quantum = 10 ** -szDecimals;
  const rawWeights = orderSizeFractions.map((fraction) => Math.max(0, fraction));
  const totalWeight = rawWeights.reduce((sum, weight) => sum + weight, 0);
  const normalizedWeights =
    totalWeight > POSITION_EPSILON ? rawWeights.map((weight) => weight / totalWeight) : orderPrices.map(() => 1 / n);
  const weightedAveragePrice = orderPrices.reduce(
    (sum, price, index) => sum + price * (normalizedWeights[index] ?? 0),
    0,
  );
  if (weightedAveragePrice <= POSITION_EPSILON) {
    return orderPrices.map(() => 0);
  }

  const idealSteps = normalizedWeights.map((weight) => (positionSizeUsd * weight) / (weightedAveragePrice * quantum));
  const steps = idealSteps.map((ideal) => Math.floor(ideal + POSITION_EPSILON));
  let plannedNotionalUsd = steps.reduce(
    (sum, sizeSteps, index) => sum + sizeSteps * quantum * (orderPrices[index] ?? 0),
    0,
  );

  const priorityIndices = orderPrices.map((_, index) => index);
  priorityIndices.sort((left, right) => {
    const remainderDelta =
      (idealSteps[right] ?? 0) - Math.floor((idealSteps[right] ?? 0) + POSITION_EPSILON) -
      ((idealSteps[left] ?? 0) - Math.floor((idealSteps[left] ?? 0) + POSITION_EPSILON));
    if (Math.abs(remainderDelta) > POSITION_EPSILON) {
      return remainderDelta;
    }

    return side === "long"
      ? (orderPrices[right] ?? 0) - (orderPrices[left] ?? 0)
      : (orderPrices[left] ?? 0) - (orderPrices[right] ?? 0);
  });

  for (const index of priorityIndices) {
    const stepNotionalUsd = (orderPrices[index] ?? 0) * quantum;
    if (stepNotionalUsd <= POSITION_EPSILON) {
      continue;
    }

    if (plannedNotionalUsd + stepNotionalUsd > positionSizeUsd + POSITION_EPSILON) {
      continue;
    }

    const priorSteps = steps[index];
    if (priorSteps === undefined) {
      continue;
    }
    steps[index] = priorSteps + 1;
    plannedNotionalUsd += stepNotionalUsd;
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
    const orderSizeFractions = signal.entryOrders.map((order) => order.sizeFraction ?? order.riskFraction ?? 0);
    const sizeUnitsList = allocateEntryOrderSizeUnits({
      positionSizeUsd,
      orderPrices,
      orderSizeFractions,
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
