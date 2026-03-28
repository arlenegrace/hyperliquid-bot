import dotenv from "dotenv";
import { z } from "zod";

import type { BotConfig } from "./types.js";

dotenv.config();

const envSchema = z.object({
  HL_API_BASE_URL: z.url().default("https://api.hyperliquid.xyz"),
  WATCHLIST: z
    .string()
    .default("BTC,ETH,SOL,CRV,BNB,XRP,SUI")
    .transform((value) =>
      value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1, "WATCHLIST must contain at least one symbol.")),
  POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  RANGE_LOOKBACK_CANDLES: z.coerce.number().int().min(5).max(5_000).default(500),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(10_000),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(250),
  MANUAL_RANGE_MAX_RISK_PCT: z.coerce.number().positive().max(0.25).default(0.05),
  STOP_BUFFER_PCT: z.coerce.number().positive().max(0.05).default(0.001),
  PIVOT_STRENGTH: z.coerce.number().int().min(1).max(10).default(3),
  PIVOT_CLUSTER_TOLERANCE_PCT: z.coerce.number().positive().max(0.05).default(0.012),
  RANGE_MIN_BOUNDARY_TOUCHES: z.coerce.number().int().min(2).max(5).default(2),
  RANGE_MIN_WIDTH_PCT: z.coerce.number().positive().max(0.25).default(0.06),
  RANGE_MAX_WIDTH_PCT: z.coerce.number().positive().max(0.5).default(0.18),
  RANGE_MAX_AGE_CANDLES: z.coerce.number().int().min(10).max(300).default(90),
  RANGE_INSIDE_CLOSE_RATIO: z.coerce.number().gt(0).lte(1).default(0.55),
  RECLAIM_LOOKBACK_CANDLES: z.coerce.number().int().min(2).max(50).default(12),
  LADDER_LEVELS: z.coerce.number().int().min(2).max(10).default(5),
  LADDER_ENTRY_BAND_PCT: z.coerce.number().gt(0).lt(0.5).default(0.2),
  LADDER_EXIT_START_PCT: z.coerce.number().gt(0).lt(1).default(0.5),
  LADDER_EXIT_END_PCT: z.coerce.number().gt(0).lte(1).default(1),
  SIGNAL_EXPIRY_CANDLES: z.coerce.number().int().min(1).max(50).default(18),
  MANUAL_RANGE_FILE: z.string().default("manual-ranges.json"),
  MANUAL_RANGE_STATE_FILE: z.string().default(".manual-range-state.json"),
  BACKTEST_SYMBOLS: z
    .string()
    .default("BTC,ETH")
    .transform((value) =>
      value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1, "BACKTEST_SYMBOLS must contain at least one symbol.")),
  BACKTEST_LOOKBACK_CANDLES: z.coerce.number().int().min(200).max(5_000).default(900),
  BACKTEST_TRADING_FEE_RATE: z.coerce.number().min(0).max(0.01).default(0.00045),
  BACKTEST_SLIPPAGE_RATE: z.coerce.number().min(0).max(0.01).default(0.0001),
});

export function loadConfig(): BotConfig {
  const env = envSchema.parse(process.env);

  return {
    apiBaseUrl: env.HL_API_BASE_URL,
    interval: "4h",
    watchlist: env.WATCHLIST,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    rangeLookbackCandles: env.RANGE_LOOKBACK_CANDLES,
    paperStartingBalanceUsd: env.PAPER_STARTING_BALANCE_USD,
    paperPositionSizeUsd: env.PAPER_POSITION_SIZE_USD,
    manualRangeMaxRiskPct: env.MANUAL_RANGE_MAX_RISK_PCT,
    stopBufferPct: env.STOP_BUFFER_PCT,
    pivotStrength: env.PIVOT_STRENGTH,
    pivotClusterTolerancePct: env.PIVOT_CLUSTER_TOLERANCE_PCT,
    rangeMinBoundaryTouches: env.RANGE_MIN_BOUNDARY_TOUCHES,
    rangeMinWidthPct: env.RANGE_MIN_WIDTH_PCT,
    rangeMaxWidthPct: env.RANGE_MAX_WIDTH_PCT,
    rangeMaxAgeCandles: env.RANGE_MAX_AGE_CANDLES,
    rangeInsideCloseRatio: env.RANGE_INSIDE_CLOSE_RATIO,
    reclaimLookbackCandles: env.RECLAIM_LOOKBACK_CANDLES,
    ladderLevels: env.LADDER_LEVELS,
    ladderEntryBandPct: env.LADDER_ENTRY_BAND_PCT,
    ladderExitStartPct: env.LADDER_EXIT_START_PCT,
    ladderExitEndPct: env.LADDER_EXIT_END_PCT,
    signalExpiryCandles: env.SIGNAL_EXPIRY_CANDLES,
    manualRangeFile: env.MANUAL_RANGE_FILE,
    manualRangeStateFile: env.MANUAL_RANGE_STATE_FILE,
    backtestSymbols: env.BACKTEST_SYMBOLS,
    backtestLookbackCandles: env.BACKTEST_LOOKBACK_CANDLES,
    backtestTradingFeeRate: env.BACKTEST_TRADING_FEE_RATE,
    backtestSlippageRate: env.BACKTEST_SLIPPAGE_RATE,
  };
}
