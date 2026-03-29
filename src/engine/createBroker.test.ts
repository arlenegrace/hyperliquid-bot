import assert from "node:assert/strict";
import test from "node:test";

import type { BotConfig } from "../types.js";
import { createBroker } from "./createBroker.js";

function createConfig(executionMode: "paper" | "live"): BotConfig {
  return {
    apiBaseUrl: "https://api.hyperliquid.xyz",
    interval: "4h",
    watchlist: ["BTC"],
    pollIntervalMs: 60_000,
    executionMode,
    rangeLookbackCandles: 500,
    paperStartingBalanceUsd: 2_000,
    paperPositionSizeUsd: 100,
    live: {
      enabled: false,
      dryRun: true,
      useTestnet: false,
      accountAddress: "0x1111111111111111111111111111111111111111",
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
      stateFile: ".live-broker-state.json",
      defaultLeverage: 3,
      marginMode: "cross",
      maxNotionalUsd: 1_000,
      maxOpenPositions: 3,
      slippageBps: 10,
      orderTimeoutMs: 10_000,
    },
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
    manualRangeStateFile: ".manual-range-state.json",
    manualRangeInvalidationExtendPct: 0.5,
    manualRangeMaxRiskPct: 0.05,
    backtestTradingFeeRate: 0,
    backtestSlippageRate: 0,
  };
}

test("createBroker returns the paper broker for paper mode", () => {
  const broker = createBroker(createConfig("paper"));
  assert.equal(broker.mode, "paper");
});

test("createBroker returns the live broker for live mode", () => {
  const broker = createBroker(createConfig("live"));
  assert.equal(broker.mode, "live");
});
