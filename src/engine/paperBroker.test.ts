import assert from "node:assert/strict";
import test from "node:test";

import { ManualRangeTradingStrategy } from "../../strategies/manualRangeTrading.js";
import { PaperBroker } from "./paperBroker.js";
import type { BotConfig, Candle, ManualRangeState, PaperPosition, StrategySignal } from "../types.js";

function createConfig(): BotConfig {
  return {
    apiBaseUrl: "https://api.hyperliquid.xyz",
    interval: "4h",
    watchlist: ["BTC"],
    pollIntervalMs: 60_000,
    rangeLookbackCandles: 500,
    paperStartingBalanceUsd: 2_000,
    paperPositionSizeUsd: 100,
    stopBufferPct: 0.001,
    pivotStrength: 3,
    pivotClusterTolerancePct: 0.012,
    rangeMinBoundaryTouches: 2,
    rangeMinWidthPct: 0.06,
    rangeMaxWidthPct: 0.18,
    rangeMaxAgeCandles: 90,
    rangeInsideCloseRatio: 0.55,
    reclaimLookbackCandles: 12,
    ladderLevels: 5,
    ladderEntryBandPct: 0.2,
    ladderExitStartPct: 0.5,
    ladderExitEndPct: 1,
    signalExpiryCandles: 18,
    backtestSymbols: ["BTC"],
    backtestLookbackCandles: 900,
    manualRangeFile: "manual-ranges.json",
    manualRangeStateFile: "manual-range-state.json",
    manualRangeMaxRiskPct: 0.05,
    backtestTradingFeeRate: 0,
    backtestSlippageRate: 0,
  };
}

function createCandle(values: Partial<Candle> & Pick<Candle, "openTime" | "closeTime">): Candle {
  return {
    symbol: "BTC",
    interval: "4h",
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    trades: 0,
    ...values,
  };
}

function createOpenPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "position-1",
    symbol: "BTC",
    strategyId: "manual-range-trading",
    side: "long",
    entryReferencePrice: 108,
    signalTime: 1,
    expiryTime: 10,
    stopLoss: 98,
    intendedSizeUnits: 10,
    filledSizeUnits: 10,
    averageEntryPrice: 108,
    remainingSizeUnits: 10,
    entryOrders: [],
    exitOrders: [],
    realizedPnlUsd: 0,
    status: "open",
    ...overrides,
  };
}

function createSignal({
  side,
  entryReferencePrice,
  stopLoss,
  ...overrides
}: Partial<StrategySignal> & Pick<StrategySignal, "side" | "entryReferencePrice" | "stopLoss">): StrategySignal {
  return {
    strategyId: "manual-range-trading",
    symbol: "BTC",
    side,
    entryReferencePrice,
    stopLoss,
    entryOrders: [],
    exitOrders: [],
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
    triggerCandle: createCandle({
      openTime: 1,
      closeTime: 2,
      open: entryReferencePrice,
      high: entryReferencePrice,
      low: entryReferencePrice,
      close: entryReferencePrice,
    }),
    reason: "test signal",
    generatedAt: 2,
    expiryTime: 10,
    ...overrides,
  };
}

test("manual range reversal keeps full flip risk budget and two-step exits", () => {
  const strategy = new ManualRangeTradingStrategy();
  const config = createConfig();
  const manualRangeState: ManualRangeState = {
    symbol: "BTC",
    fingerprint: "btc-100-120",
    isInvalidated: false,
    hasDeviatedBelow: true,
    hasDeviatedAbove: true,
    lowestLowSinceValidFrom: 98,
    highestHighSinceValidFrom: 122,
    edgeReentryEnabledLong: false,
    edgeReentryEnabledShort: false,
  };
  const openLong = createOpenPosition();
  const result = strategy.evaluate({
    symbol: "BTC",
    candles: [
      createCandle({
        openTime: 10,
        closeTime: 11,
        open: 120.5,
        high: 122,
        low: 119.5,
        close: 121,
      }),
      createCandle({
        openTime: 12,
        closeTime: 13,
        open: 119,
        high: 119.2,
        low: 117.5,
        close: 118,
      }),
    ],
    config,
    hasOpenPosition: true,
    openPositions: [openLong],
    currentEquityUsd: 2_000,
    manualRange: {
      symbol: "BTC",
      rangeLow: 100,
      rangeHigh: 120,
      validFromTime: 0,
    },
    manualRangeState,
  });

  assert.ok(result.signal, "expected a reversal signal");
  assert.equal(result.signal.entryMode, "flip");
  assert.equal(result.signal.maxRiskUsd, 100);
  assert.equal(result.signal.entryOrders.length, 2);
  assert.equal(result.signal.exitOrders.length, 2);
  assert.equal(result.signal.exitOrders[0]?.price, 110);
  assert.equal(result.signal.exitOrders[0]?.sizeFraction, 0.5);
  assert.equal(result.signal.exitOrders[1]?.price, 102);
  assert.equal(result.signal.exitOrders[1]?.sizeFraction, 0.5);
});

test("paper broker closes a long before opening a flip short", () => {
  const broker = new PaperBroker(2_000, 100);

  broker.openPosition(
    createSignal({
      side: "long",
      entryReferencePrice: 100,
      stopLoss: 95,
      maxRiskUsd: 100,
      entryOrders: [{ label: "Long Entry", price: 100, riskFraction: 1 }],
      exitOrders: [
        { label: "Take Profit 1", price: 110, sizeFraction: 0.5 },
        { label: "Take Profit 2", price: 118, sizeFraction: 0.5 },
      ],
    }),
  );

  broker.processCandle(
    "BTC",
    createCandle({
      openTime: 3,
      closeTime: 4,
      open: 109,
      high: 111,
      low: 109,
      close: 110,
    }),
  );

  broker.openPosition(
    createSignal({
      side: "short",
      entryReferencePrice: 118,
      stopLoss: 120,
      maxRiskUsd: 40,
      entryMode: "flip",
      netPositionBeforeEntry: { side: "long", sizeUnits: 10 },
      entryOrders: [{ label: "Flip Entry 1", price: 118, riskFraction: 1 }],
      exitOrders: [{ label: "Take Profit 1", price: 110, sizeFraction: 1 }],
    }),
  );

  const snapshot = broker.snapshot();
  assert.equal(snapshot.openPositions.length, 1);
  assert.equal(snapshot.openPositions[0]?.side, "short");
  assert.equal(snapshot.openPositions[0]?.remainingSizeUnits, 20);
  assert.equal(snapshot.closedPositions.length, 1);
  assert.equal(snapshot.closedPositions[0]?.side, "long");
});

test("paper broker closes a short before opening a flip long", () => {
  const broker = new PaperBroker(2_000, 100);

  broker.openPosition(
    createSignal({
      side: "short",
      entryReferencePrice: 120,
      stopLoss: 125,
      maxRiskUsd: 100,
      entryOrders: [{ label: "Short Entry", price: 120, riskFraction: 1 }],
      exitOrders: [
        { label: "Take Profit 1", price: 110, sizeFraction: 0.5 },
        { label: "Take Profit 2", price: 102, sizeFraction: 0.5 },
      ],
    }),
  );

  broker.processCandle(
    "BTC",
    createCandle({
      openTime: 3,
      closeTime: 4,
      open: 111,
      high: 111,
      low: 109,
      close: 110,
    }),
  );

  broker.openPosition(
    createSignal({
      side: "long",
      entryReferencePrice: 102,
      stopLoss: 100,
      maxRiskUsd: 40,
      entryMode: "flip",
      netPositionBeforeEntry: { side: "short", sizeUnits: 10 },
      entryOrders: [{ label: "Flip Entry 1", price: 102, riskFraction: 1 }],
      exitOrders: [{ label: "Take Profit 1", price: 110, sizeFraction: 1 }],
    }),
  );

  const snapshot = broker.snapshot();
  assert.equal(snapshot.openPositions.length, 1);
  assert.equal(snapshot.openPositions[0]?.side, "long");
  assert.equal(snapshot.openPositions[0]?.remainingSizeUnits, 20);
  assert.equal(snapshot.closedPositions.length, 1);
  assert.equal(snapshot.closedPositions[0]?.side, "short");
});
