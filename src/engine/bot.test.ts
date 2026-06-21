import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HyperliquidClient } from "../clients/hyperliquid.js";
import type { BotConfig, Candle } from "../types.js";
import { TradingBot } from "./bot.js";
import { createBroker } from "./createBroker.js";

function createConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    apiBaseUrl: "https://api.hyperliquid.xyz",
    interval: "4h",
    watchlist: ["BTC"],
    websocket: {
      candleCloseGraceMs: 10_000,
      candleBatchDebounceMs: 5_000,
      marketDataStaleMs: 300_000,
      accountDataStaleMs: 300_000,
      safetyReconcileMs: 14_400_000,
      postWriteEventWaitMs: 2_000,
      protectiveOrdersDebounceMs: 2_000,
    },
    executionMode: "paper",
    activeStrategyId: "manual-range-trading-v3",
    rangeLookbackCandles: 10,
    paperStartingBalanceUsd: 10_000,
    positionSizeUsd: 100,
    live: {
      enabled: false,
      dryRun: true,
      useTestnet: false,
      stateFile: ".live-broker-state.json",
      defaultLeverage: 3,
      marginMode: "cross",
      maxNotionalUsd: 1_000,
      maxOpenPositions: 3,
      slippageBps: 10,
      orderTimeoutMs: 10_000,
    },
    stopBufferPct: 0.001,
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
    manualRangeMaxStopExtensionPct: 0.5,
    manualRangeMaxRiskPct: 0.05,
    backtestTradingFeeRate: 0,
    backtestSlippageRate: 0,
    ...overrides,
  };
}

function createCandle(closeTime: number): Candle {
  return {
    symbol: "BTC",
    interval: "4h",
    openTime: closeTime - 4 * 60 * 60 * 1000 + 1,
    closeTime,
    open: 70_000,
    high: 71_000,
    low: 69_000,
    close: 70_500,
    volume: 1,
    trades: 1,
  };
}

async function writeManualRanges(
  directory: string,
  rangeLow: number,
  validFromTime = "2026-06-05T05:00:00.000Z",
): Promise<string> {
  const filePath = path.join(directory, "manual-ranges.json");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ranges: [
          {
            symbol: "BTC",
            rangeLow,
            rangeHigh: 72_271,
            validFromTime,
            notes: "test range",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

test("runForClosedCandles reloads manual ranges on each 4h websocket cycle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hl-bot-"));
  const manualRangeFile = await writeManualRanges(tempDir, 65_097);
  const manualRangeStateFile = path.join(tempDir, ".manual-range-state.json");
  const config = createConfig({ manualRangeFile, manualRangeStateFile });
  const broker = createBroker(config);
  await broker.initialize();
  const bot = new TradingBot(config, new HyperliquidClient(config.apiBaseUrl), broker, []);

  const closeTime = Date.parse("2026-06-05T09:00:00.000Z");
  const candlesBySymbol = new Map([["BTC", [createCandle(closeTime)]]]);

  await bot.runForClosedCandles(candlesBySymbol);
  await bot.runForClosedCandles(candlesBySymbol);

  await writeManualRanges(tempDir, 62_468);
  await bot.runForClosedCandles(candlesBySymbol);

  const statePath = await import("node:fs/promises").then((fs) => fs.readFile(manualRangeStateFile, "utf8"));
  const persistedState = JSON.parse(statePath).states[0];

  assert.equal(persistedState.fingerprint.startsWith("BTC|62468.00000000|"), true);
  assert.equal(persistedState.isInvalidated, false);
});
