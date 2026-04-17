import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateEntryOrderSizeUnits,
  allocatePrioritizedExitOrderTargets,
  buildPlannedEntryOrders,
  calculatePlannedEntryNotionalUsd,
} from "./liveGuardrails.js";
import type { StrategySignal } from "../types.js";

function createSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    strategyId: "manual-range-trading",
    symbol: "BTC",
    side: "long",
    entryReferencePrice: 100,
    stopLoss: 95,
    entryOrders: [
      { label: "Entry 1", price: 100, riskFraction: 0.4 },
      { label: "Entry 2", price: 98, riskFraction: 0.6 },
    ],
    exitOrders: [{ label: "TP 1", price: 110, sizeFraction: 1 }],
    range: {
      high: 120,
      low: 100,
      mid: 110,
      width: 20,
      widthPct: 0.2,
      lookbackCandles: 500,
      startTime: 0,
      endTime: 0,
      anchorHighTime: 0,
      anchorLowTime: 0,
      highTouchCount: 2,
      lowTouchCount: 2,
      source: "manual",
      confidenceScore: 1,
    },
    triggerCandle: {
      openTime: 1,
      closeTime: 2,
      symbol: "BTC",
      interval: "4h",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 0,
      trades: 0,
    },
    reason: "test signal",
    generatedAt: 2,
    expiryTime: 10,
    maxRiskUsd: 100,
    ...overrides,
  };
}

test("buildPlannedEntryOrders sizes entries from risk budget", () => {
  const orders = buildPlannedEntryOrders(createSignal(), 250);
  assert.equal(orders.length, 2);
  assert.equal(orders[0]?.sizeUnits, 8);
  assert.equal(orders[1]?.sizeUnits, 20);
});

test("calculatePlannedEntryNotionalUsd sums the ladder notional", () => {
  const orders = buildPlannedEntryOrders(createSignal(), 250);
  assert.equal(calculatePlannedEntryNotionalUsd(orders), 2_760);
});

test("allocateEntryOrderSizeUnits gives remainder steps to highest-priced long limits first", () => {
  const prices = [94.058, 93.661, 93.263, 92.865, 92.468];
  const sizes = allocateEntryOrderSizeUnits({
    positionSizeUsd: 120,
    orderPrices: prices,
    orderSizeFractions: prices.map(() => 0.2),
    szDecimals: 2,
    side: "long",
  });

  assert.deepEqual(sizes, [0.26, 0.26, 0.26, 0.25, 0.25]);
});

test("allocateEntryOrderSizeUnits gives remainder steps to lowest-priced short limits first", () => {
  const prices = [92.468, 92.865, 93.263, 93.661, 94.058];
  const sizes = allocateEntryOrderSizeUnits({
    positionSizeUsd: 120,
    orderPrices: prices,
    orderSizeFractions: prices.map(() => 0.2),
    szDecimals: 2,
    side: "short",
  });

  assert.deepEqual(sizes, [0.26, 0.26, 0.26, 0.25, 0.25]);
});

test("buildPlannedEntryOrders keeps short ladder notional under the configured USD size cap", () => {
  const signal = createSignal({
    side: "short",
    maxRiskUsd: undefined,
    entryReferencePrice: 89.03,
    positionSizeUsd: 200,
    entryOrders: [
      { label: "Entry 1", price: 89.03, sizeFraction: 0.2 },
      { label: "Entry 2", price: 89.2, sizeFraction: 0.2 },
      { label: "Entry 3", price: 89.37, sizeFraction: 0.2 },
      { label: "Entry 4", price: 89.54, sizeFraction: 0.2 },
      { label: "Entry 5", price: 89.71, sizeFraction: 0.2 },
    ],
  });
  const orders = buildPlannedEntryOrders(signal, 200, { szDecimals: 2 });

  assert.deepEqual(
    orders.map((order) => order.sizeUnits),
    [0.45, 0.45, 0.45, 0.44, 0.44],
  );
  assert.ok(calculatePlannedEntryNotionalUsd(orders) <= 200);
});

test("allocatePrioritizedExitOrderTargets keeps five fractional take-profit orders when precision allows", () => {
  const targets = allocatePrioritizedExitOrderTargets({
    totalSizeUnits: 17,
    exitPrices: [1.45, 1.46, 1.47, 1.48, 1.49],
    sizeDecimals: 1,
    minOrderNotionalUsd: 0,
  });

  assert.deepEqual(targets, [3.4, 3.4, 3.4, 3.4, 3.4]);
});

test("allocatePrioritizedExitOrderTargets pushes any precision remainder into the first take-profit order", () => {
  const targets = allocatePrioritizedExitOrderTargets({
    totalSizeUnits: 17.1,
    exitPrices: [1.45, 1.46, 1.47, 1.48, 1.49],
    sizeDecimals: 1,
    minOrderNotionalUsd: 0,
  });

  assert.deepEqual(targets, [3.5, 3.4, 3.4, 3.4, 3.4]);
});

test("allocatePrioritizedExitOrderTargets drops only the highest-priority tail orders when minimum notional blocks all five", () => {
  const targets = allocatePrioritizedExitOrderTargets({
    totalSizeUnits: 30,
    exitPrices: [1.45, 1.46, 1.47, 1.48, 1.49],
    sizeDecimals: 1,
    minOrderNotionalUsd: 10,
  });

  assert.deepEqual(targets, [7.5, 7.5, 7.5, 7.5, 0]);
});

test("allocatePrioritizedExitOrderTargets can collapse to two take-profit orders when smaller slices would be rejected", () => {
  const targets = allocatePrioritizedExitOrderTargets({
    totalSizeUnits: 17,
    exitPrices: [1.45, 1.46, 1.47, 1.48, 1.49],
    sizeDecimals: 1,
    minOrderNotionalUsd: 10,
  });

  assert.deepEqual(targets, [8.5, 8.5, 0, 0, 0]);
});
