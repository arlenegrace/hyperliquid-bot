import { loadConfig } from "./config.js";
import { HyperliquidClient } from "./clients/hyperliquid.js";
import { formatConsoleSymbol, formatConsoleSymbolList } from "./consoleFormat.js";
import { TradingBot } from "./engine/bot.js";
import { PaperBroker } from "./engine/paperBroker.js";
import {
  getManualRangeForSymbol,
  loadManualRanges,
  loadManualRangeStates,
  syncManualRangeState,
} from "./manualRanges.js";
import { createStrategies } from "../strategies/index.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";

function colorize(symbol: string, color: string): string {
  return `${color}${formatConsoleSymbol(symbol)}${ANSI_RESET}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runOnceMode = process.argv.includes("--once");
  const marketDataClient = new HyperliquidClient(config.apiBaseUrl);
  const manualRanges = await loadManualRanges(config.manualRangeFile);
  const persistedStates = await loadManualRangeStates(config.manualRangeStateFile);
  const paperBroker = new PaperBroker(config.paperStartingBalanceUsd, config.paperPositionSizeUsd);
  const strategies = createStrategies();
  const bot = new TradingBot(config, marketDataClient, paperBroker, strategies);

  console.log(`[boot] Hyperliquid paper bot started in ${runOnceMode ? "single-run" : "interval"} mode.`);
  console.log(
    `[boot] Watchlist ${formatConsoleSymbolList(config.watchlist)} | interval ${config.interval} | lookback ${config.rangeLookbackCandles} candles.`,
  );

  const rangeStatuses = config.watchlist.map((symbol) => {
    const manualRange = getManualRangeForSymbol(manualRanges, symbol);
    if (!manualRange) {
      return `${colorize(symbol, ANSI_RED)} (missing range)`;
    }

    const syncedState = syncManualRangeState(persistedStates.get(symbol), manualRange);
    if (syncedState.isInvalidated) {
      return `${colorize(symbol, ANSI_RED)} (range invalidated)`;
    }

    return `${colorize(symbol, ANSI_GREEN)} (${manualRange.rangeLow.toFixed(2)} - ${manualRange.rangeHigh.toFixed(2)})`;
  });
  console.log(`[boot] Manual range coverage: ${rangeStatuses.join(", ")}`);

  let cycleRunning = false;

  const executeCycle = async (): Promise<void> => {
    if (cycleRunning) {
      console.log("[bot] Previous cycle still running, skipping this tick.");
      return;
    }

    cycleRunning = true;
    try {
      await bot.runOnce();
    } finally {
      cycleRunning = false;
    }
  };

  await executeCycle();

  if (runOnceMode) {
    return;
  }

  const timer = setInterval(() => {
    void executeCycle();
  }, config.pollIntervalMs);

  const shutdown = (): void => {
    clearInterval(timer);
    console.log("[boot] Shutdown requested. Exiting bot loop.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exit(1);
});
