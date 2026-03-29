import dotenv from "dotenv";
import { z } from "zod";

import type { BotConfig } from "./types.js";

dotenv.config();

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
      .default(defaultValue ? "true" : "false")
      .transform((value) => ["true", "1", "yes", "on"].includes(value)),
  );

const ethereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected an Ethereum address like 0xabc...")
  .transform((value) => value as `0x${string}`);

const privateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Expected a 32-byte hex private key prefixed with 0x.")
  .transform((value) => value as `0x${string}`);

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
  EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),
  RANGE_LOOKBACK_CANDLES: z.coerce.number().int().min(5).max(5_000).default(500),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(10_000),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(250),
  LIVE_TRADING_ENABLED: booleanEnv(false),
  LIVE_DRY_RUN: booleanEnv(true),
  HL_USE_TESTNET: booleanEnv(false),
  HL_ACCOUNT_ADDRESS: ethereumAddressSchema.optional(),
  HL_PRIVATE_KEY: privateKeySchema.optional(),
  LIVE_STATE_FILE: z.string().default(".live-broker-state.json"),
  LIVE_DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(100).default(3),
  LIVE_MARGIN_MODE: z.enum(["cross", "isolated"]).default("cross"),
  LIVE_MAX_NOTIONAL_USD: z.coerce.number().positive().default(1_000),
  LIVE_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(3),
  LIVE_SLIPPAGE_BPS: z.coerce.number().min(0).max(500).default(10),
  LIVE_ORDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
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
  MANUAL_RANGE_INVALIDATION_EXTEND_PCT: z.coerce.number().min(0).max(5).default(0.5),
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
  if (env.EXECUTION_MODE === "live" && !env.HL_PRIVATE_KEY) {
    throw new Error("HL_PRIVATE_KEY must be set when EXECUTION_MODE=live.");
  }

  if (env.EXECUTION_MODE === "live" && !env.HL_ACCOUNT_ADDRESS) {
    throw new Error("HL_ACCOUNT_ADDRESS must be set when EXECUTION_MODE=live.");
  }

  return {
    apiBaseUrl: env.HL_API_BASE_URL,
    interval: "4h",
    watchlist: env.WATCHLIST,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    executionMode: env.EXECUTION_MODE,
    rangeLookbackCandles: env.RANGE_LOOKBACK_CANDLES,
    paperStartingBalanceUsd: env.PAPER_STARTING_BALANCE_USD,
    paperPositionSizeUsd: env.PAPER_POSITION_SIZE_USD,
    live: {
      enabled: env.LIVE_TRADING_ENABLED,
      dryRun: env.LIVE_DRY_RUN,
      useTestnet: env.HL_USE_TESTNET,
      ...(env.HL_ACCOUNT_ADDRESS ? { accountAddress: env.HL_ACCOUNT_ADDRESS } : {}),
      ...(env.HL_PRIVATE_KEY ? { privateKey: env.HL_PRIVATE_KEY } : {}),
      stateFile: env.LIVE_STATE_FILE,
      defaultLeverage: env.LIVE_DEFAULT_LEVERAGE,
      marginMode: env.LIVE_MARGIN_MODE,
      maxNotionalUsd: env.LIVE_MAX_NOTIONAL_USD,
      maxOpenPositions: env.LIVE_MAX_OPEN_POSITIONS,
      slippageBps: env.LIVE_SLIPPAGE_BPS,
      orderTimeoutMs: env.LIVE_ORDER_TIMEOUT_MS,
    },
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
    manualRangeInvalidationExtendPct: env.MANUAL_RANGE_INVALIDATION_EXTEND_PCT,
    backtestSymbols: env.BACKTEST_SYMBOLS,
    backtestLookbackCandles: env.BACKTEST_LOOKBACK_CANDLES,
    backtestTradingFeeRate: env.BACKTEST_TRADING_FEE_RATE,
    backtestSlippageRate: env.BACKTEST_SLIPPAGE_RATE,
  };
}
