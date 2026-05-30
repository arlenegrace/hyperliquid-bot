import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ActiveStrategyId, BotConfig } from "./types.js";

dotenv.config();

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
      .default(defaultValue ? "true" : "false")
      .transform((value) => ["true", "1", "yes", "on"].includes(value)),
  );

const leverageEnv = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.union([z.literal("max"), z.coerce.number().int().min(1).max(100)]).default("max"),
);

const ethereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected an Ethereum address like 0xabc...")
  .transform((value) => value as `0x${string}`);

const privateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Expected a 32-byte hex private key prefixed with 0x.")
  .transform((value) => value as `0x${string}`);

const activeStrategyIdSchema = z
  .enum(["manual-range-trading-v1", "manual-range-trading-v2", "manual-range-trading-v3"])
  .transform((value) => value as ActiveStrategyId);

const runtimeModeSchema = z.enum(["websocket", "poll"]);

const websocketConfigSchema = z
  .object({
    candleCloseGraceMs: z.coerce.number().int().min(0).max(5 * 60_000).optional(),
    candleBatchDebounceMs: z.coerce.number().int().min(0).max(60_000).optional(),
    marketDataStaleMs: z.coerce.number().int().min(60_000).optional(),
    accountDataStaleMs: z.coerce.number().int().min(60_000).optional(),
    safetyReconcileMs: z.coerce.number().int().min(0).optional(),
    postWriteEventWaitMs: z.coerce.number().int().min(0).max(30_000).optional(),
    protectiveOrdersDebounceMs: z.coerce.number().int().min(0).max(60_000).optional(),
  })
  .strict();

/** Parsed JSON file; credentials must not appear here (use .env). */
const configFileSchema = z
  .object({
    apiBaseUrl: z.string().url().optional(),
    watchlist: z.array(z.string()).optional(),
    pollIntervalMs: z.coerce.number().int().min(5_000).optional(),
    runtimeMode: runtimeModeSchema.optional(),
    websocket: websocketConfigSchema.optional(),
    executionMode: z.enum(["paper", "live"]).optional(),
    activeStrategyId: activeStrategyIdSchema.optional(),
    rangeLookbackCandles: z.coerce.number().int().min(5).max(5_000).optional(),
    paperStartingBalanceUsd: z.coerce.number().positive().optional(),
    positionSizeUsd: z.coerce.number().positive().optional(),
    live: z
      .object({
        enabled: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        useTestnet: z.boolean().optional(),
        stateFile: z.string().optional(),
        defaultLeverage: z.union([z.literal("max"), z.coerce.number().int().min(1).max(100)]).optional(),
        marginMode: z.enum(["cross", "isolated"]).optional(),
        maxNotionalUsd: z.coerce.number().positive().optional(),
        maxOpenPositions: z.coerce.number().int().positive().optional(),
        slippageBps: z.coerce.number().min(0).max(500).optional(),
        orderTimeoutMs: z.coerce.number().int().min(1_000).max(60_000).optional(),
      })
      .strict()
      .optional(),
    manualRangeMaxRiskPct: z.coerce.number().positive().max(0.25).optional(),
    manualRangeMaxStopExtensionPct: z.coerce.number().positive().max(2).optional(),
    stopBufferPct: z.coerce.number().positive().max(0.05).optional(),
    reclaimLookbackCandles: z.coerce.number().int().min(2).max(50).optional(),
    ladderLevels: z.coerce.number().int().min(2).max(10).optional(),
    ladderEntryBandPct: z.coerce.number().gt(0).lt(0.5).optional(),
    ladderExitStartPct: z.coerce.number().gt(0).lt(1).optional(),
    ladderExitEndPct: z.coerce.number().gt(0).lte(1).optional(),
    signalExpiryCandles: z.coerce.number().int().min(1).max(50).optional(),
    manualRangeFile: z.string().optional(),
    manualRangeStateFile: z.string().optional(),
    manualRangeInvalidationExtendPct: z.coerce.number().min(0).max(5).optional(),
    backtestSymbols: z.array(z.string()).optional(),
    backtestLookbackCandles: z.coerce.number().int().min(200).max(5_000).optional(),
    backtestTradingFeeRate: z.coerce.number().min(0).max(0.01).optional(),
    backtestSlippageRate: z.coerce.number().min(0).max(0.01).optional(),
  })
  .strict();

const fullConfigSchema = z.object({
  apiBaseUrl: z.string().url(),
  watchlist: z.array(z.string()).min(1, "watchlist must contain at least one symbol."),
  pollIntervalMs: z.coerce.number().int().min(5_000),
  runtimeMode: runtimeModeSchema,
  websocket: websocketConfigSchema.required({
    candleCloseGraceMs: true,
    candleBatchDebounceMs: true,
    marketDataStaleMs: true,
    accountDataStaleMs: true,
    safetyReconcileMs: true,
    postWriteEventWaitMs: true,
    protectiveOrdersDebounceMs: true,
  }),
  executionMode: z.enum(["paper", "live"]),
  activeStrategyId: activeStrategyIdSchema,
  rangeLookbackCandles: z.coerce.number().int().min(5).max(5_000),
  paperStartingBalanceUsd: z.coerce.number().positive(),
  positionSizeUsd: z.coerce.number().positive(),
  live: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    useTestnet: z.boolean(),
    accountAddress: ethereumAddressSchema.optional(),
    privateKey: privateKeySchema.optional(),
    stateFile: z.string(),
    defaultLeverage: z.union([z.literal("max"), z.coerce.number().int().min(1).max(100)]),
    marginMode: z.enum(["cross", "isolated"]),
    maxNotionalUsd: z.coerce.number().positive(),
    maxOpenPositions: z.coerce.number().int().positive(),
    slippageBps: z.coerce.number().min(0).max(500),
    orderTimeoutMs: z.coerce.number().int().min(1_000).max(60_000),
  }),
  manualRangeMaxRiskPct: z.coerce.number().positive().max(0.25),
  manualRangeMaxStopExtensionPct: z.coerce.number().positive().max(2),
  stopBufferPct: z.coerce.number().positive().max(0.05),
  reclaimLookbackCandles: z.coerce.number().int().min(2).max(50),
  ladderLevels: z.coerce.number().int().min(2).max(10),
  ladderEntryBandPct: z.coerce.number().gt(0).lt(0.5),
  ladderExitStartPct: z.coerce.number().gt(0).lt(1),
  ladderExitEndPct: z.coerce.number().gt(0).lte(1),
  signalExpiryCandles: z.coerce.number().int().min(1).max(50),
  manualRangeFile: z.string(),
  manualRangeStateFile: z.string(),
  manualRangeInvalidationExtendPct: z.coerce.number().min(0).max(5),
  backtestSymbols: z.array(z.string()).min(1, "backtestSymbols must contain at least one symbol."),
  backtestLookbackCandles: z.coerce.number().int().min(200).max(5_000),
  backtestTradingFeeRate: z.coerce.number().min(0).max(0.01),
  backtestSlippageRate: z.coerce.number().min(0).max(0.01),
});

type FullConfig = z.infer<typeof fullConfigSchema>;

type ConfigPatch = {
  [K in keyof FullConfig]?: K extends "live"
    ? Partial<FullConfig["live"]>
    : K extends "websocket"
      ? Partial<FullConfig["websocket"]>
      : FullConfig[K];
};

const defaultConfig: FullConfig = {
  apiBaseUrl: "https://api.hyperliquid.xyz",
  watchlist: ["BTC", "ETH", "SOL", "CRV", "BNB", "XRP", "SUI"],
  pollIntervalMs: 3_600_000,
  runtimeMode: "websocket",
  websocket: {
    candleCloseGraceMs: 10_000,
    candleBatchDebounceMs: 5_000,
    marketDataStaleMs: 5 * 60_000,
    accountDataStaleMs: 5 * 60_000,
    safetyReconcileMs: 4 * 60 * 60_000,
    postWriteEventWaitMs: 2_000,
    protectiveOrdersDebounceMs: 2_000,
  },
  executionMode: "paper",
  activeStrategyId: "manual-range-trading-v3",
  rangeLookbackCandles: 500,
  paperStartingBalanceUsd: 10_000,
  positionSizeUsd: 20,
  live: {
    enabled: false,
    dryRun: true,
    useTestnet: false,
    stateFile: ".live-broker-state.json",
    defaultLeverage: "max",
    marginMode: "cross",
    maxNotionalUsd: 5_000,
    maxOpenPositions: 10,
    slippageBps: 10,
    orderTimeoutMs: 10_000,
  },
  manualRangeMaxRiskPct: 0.05,
  manualRangeMaxStopExtensionPct: 0.5,
  stopBufferPct: 0.001,
  reclaimLookbackCandles: 12,
  ladderLevels: 5,
  ladderEntryBandPct: 0.2,
  ladderExitStartPct: 0.5,
  ladderExitEndPct: 1,
  signalExpiryCandles: 18,
  manualRangeFile: "manual-ranges.json",
  manualRangeStateFile: ".manual-range-state.json",
  manualRangeInvalidationExtendPct: 0.5,
  backtestSymbols: ["BTC", "ETH"],
  backtestLookbackCandles: 900,
  backtestTradingFeeRate: 0.00045,
  backtestSlippageRate: 0.001,
};

function mergeConfigPatch(base: FullConfig, patch: ConfigPatch): FullConfig {
  const { live, websocket, ...rest } = patch;
  return {
    ...base,
    ...rest,
    live: { ...base.live, ...(live ?? {}) },
    websocket: { ...base.websocket, ...(websocket ?? {}) },
  };
}

function readConfigFileFromDisk(): z.infer<typeof configFileSchema> | undefined {
  const rawPath = process.env.HL_BOT_CONFIG ?? "config.json";
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(resolved)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Failed to read or parse config file ${resolved}.`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${resolved} must be a JSON object.`);
  }
  return configFileSchema.parse(parsed);
}

/** Non-secret overrides only; same env names as before this refactor. */
function legacyEnvPatch(env: NodeJS.ProcessEnv): ConfigPatch {
  const patch: ConfigPatch = {};
  const live: NonNullable<ConfigPatch["live"]> = {};

  if (env.HL_API_BASE_URL !== undefined && env.HL_API_BASE_URL !== "") {
    patch.apiBaseUrl = env.HL_API_BASE_URL;
  }
  if (env.WATCHLIST !== undefined && env.WATCHLIST !== "") {
    patch.watchlist = env.WATCHLIST.split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
  }
  if (env.POLL_INTERVAL_MS !== undefined && env.POLL_INTERVAL_MS !== "") {
    patch.pollIntervalMs = z.coerce.number().int().min(5_000).parse(env.POLL_INTERVAL_MS);
  }
  if (env.RUNTIME_MODE !== undefined && env.RUNTIME_MODE !== "") {
    patch.runtimeMode = runtimeModeSchema.parse(env.RUNTIME_MODE);
  }
  if (env.EXECUTION_MODE !== undefined && env.EXECUTION_MODE !== "") {
    patch.executionMode = z.enum(["paper", "live"]).parse(env.EXECUTION_MODE);
  }
  if (env.ACTIVE_STRATEGY !== undefined && env.ACTIVE_STRATEGY !== "") {
    patch.activeStrategyId = activeStrategyIdSchema.parse(env.ACTIVE_STRATEGY);
  }
  if (env.RANGE_LOOKBACK_CANDLES !== undefined && env.RANGE_LOOKBACK_CANDLES !== "") {
    patch.rangeLookbackCandles = z.coerce.number().int().min(5).max(5_000).parse(env.RANGE_LOOKBACK_CANDLES);
  }
  if (env.PAPER_STARTING_BALANCE_USD !== undefined && env.PAPER_STARTING_BALANCE_USD !== "") {
    patch.paperStartingBalanceUsd = z.coerce.number().positive().parse(env.PAPER_STARTING_BALANCE_USD);
  }
  if (env.POSITION_SIZE_USD !== undefined && env.POSITION_SIZE_USD !== "") {
    patch.positionSizeUsd = z.coerce.number().positive().parse(env.POSITION_SIZE_USD);
  }
  if (env.MANUAL_RANGE_MAX_RISK_PCT !== undefined && env.MANUAL_RANGE_MAX_RISK_PCT !== "") {
    patch.manualRangeMaxRiskPct = z.coerce.number().positive().max(0.25).parse(env.MANUAL_RANGE_MAX_RISK_PCT);
  }
  if (env.MANUAL_RANGE_MAX_STOP_EXTENSION_PCT !== undefined && env.MANUAL_RANGE_MAX_STOP_EXTENSION_PCT !== "") {
    patch.manualRangeMaxStopExtensionPct = z.coerce
      .number()
      .positive()
      .max(2)
      .parse(env.MANUAL_RANGE_MAX_STOP_EXTENSION_PCT);
  }
  if (env.STOP_BUFFER_PCT !== undefined && env.STOP_BUFFER_PCT !== "") {
    patch.stopBufferPct = z.coerce.number().positive().max(0.05).parse(env.STOP_BUFFER_PCT);
  }
  if (env.RECLAIM_LOOKBACK_CANDLES !== undefined && env.RECLAIM_LOOKBACK_CANDLES !== "") {
    patch.reclaimLookbackCandles = z.coerce.number().int().min(2).max(50).parse(env.RECLAIM_LOOKBACK_CANDLES);
  }
  if (env.LADDER_LEVELS !== undefined && env.LADDER_LEVELS !== "") {
    patch.ladderLevels = z.coerce.number().int().min(2).max(10).parse(env.LADDER_LEVELS);
  }
  if (env.LADDER_ENTRY_BAND_PCT !== undefined && env.LADDER_ENTRY_BAND_PCT !== "") {
    patch.ladderEntryBandPct = z.coerce.number().gt(0).lt(0.5).parse(env.LADDER_ENTRY_BAND_PCT);
  }
  if (env.LADDER_EXIT_START_PCT !== undefined && env.LADDER_EXIT_START_PCT !== "") {
    patch.ladderExitStartPct = z.coerce.number().gt(0).lt(1).parse(env.LADDER_EXIT_START_PCT);
  }
  if (env.LADDER_EXIT_END_PCT !== undefined && env.LADDER_EXIT_END_PCT !== "") {
    patch.ladderExitEndPct = z.coerce.number().gt(0).lte(1).parse(env.LADDER_EXIT_END_PCT);
  }
  if (env.SIGNAL_EXPIRY_CANDLES !== undefined && env.SIGNAL_EXPIRY_CANDLES !== "") {
    patch.signalExpiryCandles = z.coerce.number().int().min(1).max(50).parse(env.SIGNAL_EXPIRY_CANDLES);
  }
  if (env.MANUAL_RANGE_FILE !== undefined && env.MANUAL_RANGE_FILE !== "") {
    patch.manualRangeFile = env.MANUAL_RANGE_FILE;
  }
  if (env.MANUAL_RANGE_STATE_FILE !== undefined && env.MANUAL_RANGE_STATE_FILE !== "") {
    patch.manualRangeStateFile = env.MANUAL_RANGE_STATE_FILE;
  }
  if (env.MANUAL_RANGE_INVALIDATION_EXTEND_PCT !== undefined && env.MANUAL_RANGE_INVALIDATION_EXTEND_PCT !== "") {
    patch.manualRangeInvalidationExtendPct = z.coerce
      .number()
      .min(0)
      .max(5)
      .parse(env.MANUAL_RANGE_INVALIDATION_EXTEND_PCT);
  }
  if (env.BACKTEST_SYMBOLS !== undefined && env.BACKTEST_SYMBOLS !== "") {
    patch.backtestSymbols = env.BACKTEST_SYMBOLS.split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
  }
  if (env.BACKTEST_LOOKBACK_CANDLES !== undefined && env.BACKTEST_LOOKBACK_CANDLES !== "") {
    patch.backtestLookbackCandles = z.coerce.number().int().min(200).max(5_000).parse(env.BACKTEST_LOOKBACK_CANDLES);
  }
  if (env.BACKTEST_TRADING_FEE_RATE !== undefined && env.BACKTEST_TRADING_FEE_RATE !== "") {
    patch.backtestTradingFeeRate = z.coerce.number().min(0).max(0.01).parse(env.BACKTEST_TRADING_FEE_RATE);
  }
  if (env.BACKTEST_SLIPPAGE_RATE !== undefined && env.BACKTEST_SLIPPAGE_RATE !== "") {
    patch.backtestSlippageRate = z.coerce.number().min(0).max(0.01).parse(env.BACKTEST_SLIPPAGE_RATE);
  }

  const websocket: NonNullable<ConfigPatch["websocket"]> = {};
  if (env.WS_CANDLE_CLOSE_GRACE_MS !== undefined && env.WS_CANDLE_CLOSE_GRACE_MS !== "") {
    websocket.candleCloseGraceMs = z.coerce.number().int().min(0).max(5 * 60_000).parse(env.WS_CANDLE_CLOSE_GRACE_MS);
  }
  if (env.WS_CANDLE_BATCH_DEBOUNCE_MS !== undefined && env.WS_CANDLE_BATCH_DEBOUNCE_MS !== "") {
    websocket.candleBatchDebounceMs = z.coerce
      .number()
      .int()
      .min(0)
      .max(60_000)
      .parse(env.WS_CANDLE_BATCH_DEBOUNCE_MS);
  }
  if (env.WS_MARKET_DATA_STALE_MS !== undefined && env.WS_MARKET_DATA_STALE_MS !== "") {
    websocket.marketDataStaleMs = z.coerce.number().int().min(60_000).parse(env.WS_MARKET_DATA_STALE_MS);
  }
  if (env.WS_ACCOUNT_DATA_STALE_MS !== undefined && env.WS_ACCOUNT_DATA_STALE_MS !== "") {
    websocket.accountDataStaleMs = z.coerce.number().int().min(60_000).parse(env.WS_ACCOUNT_DATA_STALE_MS);
  }
  if (env.WS_SAFETY_RECONCILE_MS !== undefined && env.WS_SAFETY_RECONCILE_MS !== "") {
    websocket.safetyReconcileMs = z.coerce.number().int().min(0).parse(env.WS_SAFETY_RECONCILE_MS);
  }
  if (env.WS_POST_WRITE_EVENT_WAIT_MS !== undefined && env.WS_POST_WRITE_EVENT_WAIT_MS !== "") {
    websocket.postWriteEventWaitMs = z.coerce
      .number()
      .int()
      .min(0)
      .max(30_000)
      .parse(env.WS_POST_WRITE_EVENT_WAIT_MS);
  }
  if (env.WS_PROTECTIVE_ORDERS_DEBOUNCE_MS !== undefined && env.WS_PROTECTIVE_ORDERS_DEBOUNCE_MS !== "") {
    websocket.protectiveOrdersDebounceMs = z.coerce
      .number()
      .int()
      .min(0)
      .max(60_000)
      .parse(env.WS_PROTECTIVE_ORDERS_DEBOUNCE_MS);
  }
  if (Object.keys(websocket).length > 0) {
    patch.websocket = websocket;
  }

  if (env.LIVE_TRADING_ENABLED !== undefined && env.LIVE_TRADING_ENABLED !== "") {
    live.enabled = booleanEnv(false).parse(env.LIVE_TRADING_ENABLED);
  }
  if (env.LIVE_DRY_RUN !== undefined && env.LIVE_DRY_RUN !== "") {
    live.dryRun = booleanEnv(true).parse(env.LIVE_DRY_RUN);
  }
  if (env.HL_USE_TESTNET !== undefined && env.HL_USE_TESTNET !== "") {
    live.useTestnet = booleanEnv(false).parse(env.HL_USE_TESTNET);
  }
  if (env.LIVE_STATE_FILE !== undefined && env.LIVE_STATE_FILE !== "") {
    live.stateFile = env.LIVE_STATE_FILE;
  }
  if (env.LIVE_DEFAULT_LEVERAGE !== undefined && env.LIVE_DEFAULT_LEVERAGE !== "") {
    live.defaultLeverage = leverageEnv.parse(env.LIVE_DEFAULT_LEVERAGE);
  }
  if (env.LIVE_MARGIN_MODE !== undefined && env.LIVE_MARGIN_MODE !== "") {
    live.marginMode = z.enum(["cross", "isolated"]).parse(env.LIVE_MARGIN_MODE);
  }
  if (env.LIVE_MAX_NOTIONAL_USD !== undefined && env.LIVE_MAX_NOTIONAL_USD !== "") {
    live.maxNotionalUsd = z.coerce.number().positive().parse(env.LIVE_MAX_NOTIONAL_USD);
  }
  if (env.LIVE_MAX_OPEN_POSITIONS !== undefined && env.LIVE_MAX_OPEN_POSITIONS !== "") {
    live.maxOpenPositions = z.coerce.number().int().positive().parse(env.LIVE_MAX_OPEN_POSITIONS);
  }
  if (env.LIVE_SLIPPAGE_BPS !== undefined && env.LIVE_SLIPPAGE_BPS !== "") {
    live.slippageBps = z.coerce.number().min(0).max(500).parse(env.LIVE_SLIPPAGE_BPS);
  }
  if (env.LIVE_ORDER_TIMEOUT_MS !== undefined && env.LIVE_ORDER_TIMEOUT_MS !== "") {
    live.orderTimeoutMs = z.coerce.number().int().min(1_000).max(60_000).parse(env.LIVE_ORDER_TIMEOUT_MS);
  }

  if (Object.keys(live).length > 0) {
    patch.live = live;
  }
  return patch;
}

function applySecretsFromEnv(merged: FullConfig, env: NodeJS.ProcessEnv): void {
  if (env.HL_ACCOUNT_ADDRESS !== undefined && env.HL_ACCOUNT_ADDRESS !== "") {
    merged.live.accountAddress = ethereumAddressSchema.parse(env.HL_ACCOUNT_ADDRESS);
  }
  if (env.HL_PRIVATE_KEY !== undefined && env.HL_PRIVATE_KEY !== "") {
    merged.live.privateKey = privateKeySchema.parse(env.HL_PRIVATE_KEY);
  }
}

/** Merge: built-in defaults → legacy non-secret env vars → `config.json` (wins on overlap) → HL_* secrets from `.env`. */
export function loadConfig(): BotConfig {
  let merged = defaultConfig;
  merged = mergeConfigPatch(merged, legacyEnvPatch(process.env));
  const fileLayer = readConfigFileFromDisk();
  if (fileLayer) {
    merged = mergeConfigPatch(merged, fileLayer as ConfigPatch);
  }
  applySecretsFromEnv(merged, process.env);

  const parsed = fullConfigSchema.parse(merged);

  if (parsed.executionMode === "live" && !parsed.live.privateKey) {
    throw new Error("HL_PRIVATE_KEY must be set when EXECUTION_MODE=live (or executionMode: \"live\" in config.json).");
  }

  if (parsed.executionMode === "live" && !parsed.live.accountAddress) {
    throw new Error("HL_ACCOUNT_ADDRESS must be set when EXECUTION_MODE=live (or executionMode: \"live\" in config.json).");
  }

  return {
    apiBaseUrl: parsed.apiBaseUrl,
    interval: "4h",
    watchlist: parsed.watchlist,
    pollIntervalMs: parsed.pollIntervalMs,
    runtimeMode: parsed.runtimeMode,
    websocket: parsed.websocket,
    executionMode: parsed.executionMode,
    activeStrategyId: parsed.activeStrategyId,
    rangeLookbackCandles: parsed.rangeLookbackCandles,
    paperStartingBalanceUsd: parsed.paperStartingBalanceUsd,
    positionSizeUsd: parsed.positionSizeUsd,
    live: {
      enabled: parsed.live.enabled,
      dryRun: parsed.live.dryRun,
      useTestnet: parsed.live.useTestnet,
      ...(parsed.live.accountAddress ? { accountAddress: parsed.live.accountAddress } : {}),
      ...(parsed.live.privateKey ? { privateKey: parsed.live.privateKey } : {}),
      stateFile: parsed.live.stateFile,
      defaultLeverage: parsed.live.defaultLeverage,
      marginMode: parsed.live.marginMode,
      maxNotionalUsd: parsed.live.maxNotionalUsd,
      maxOpenPositions: parsed.live.maxOpenPositions,
      slippageBps: parsed.live.slippageBps,
      orderTimeoutMs: parsed.live.orderTimeoutMs,
    },
    manualRangeMaxRiskPct: parsed.manualRangeMaxRiskPct,
    stopBufferPct: parsed.stopBufferPct,
    reclaimLookbackCandles: parsed.reclaimLookbackCandles,
    ladderLevels: parsed.ladderLevels,
    ladderEntryBandPct: parsed.ladderEntryBandPct,
    ladderExitStartPct: parsed.ladderExitStartPct,
    ladderExitEndPct: parsed.ladderExitEndPct,
    signalExpiryCandles: parsed.signalExpiryCandles,
    manualRangeFile: parsed.manualRangeFile,
    manualRangeStateFile: parsed.manualRangeStateFile,
    manualRangeInvalidationExtendPct: parsed.manualRangeInvalidationExtendPct,
    manualRangeMaxStopExtensionPct: parsed.manualRangeMaxStopExtensionPct,
    backtestSymbols: parsed.backtestSymbols,
    backtestLookbackCandles: parsed.backtestLookbackCandles,
    backtestTradingFeeRate: parsed.backtestTradingFeeRate,
    backtestSlippageRate: parsed.backtestSlippageRate,
  };
}
