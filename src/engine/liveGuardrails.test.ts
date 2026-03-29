import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannedEntryOrders, calculatePlannedEntryNotionalUsd } from "./liveGuardrails.js";
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
