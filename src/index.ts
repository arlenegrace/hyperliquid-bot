import { loadConfig } from "./config.js";
import { HyperliquidClient } from "./clients/hyperliquid.js";
import {
  ANSI_GREEN,
  ANSI_RED,
  ANSI_RESET,
  formatConsoleSymbol,
  formatConsoleSymbolList,
  formatPerpPriceForConsole,
  wrapOrange,
} from "./consoleFormat.js";
import { TradingBot } from "./engine/bot.js";
import { createBroker } from "./engine/createBroker.js";
import { WebsocketRunner } from "./engine/websocketRunner.js";
import {
  getManualRangeForSymbol,
  loadManualRanges,
  loadManualRangeStates,
  syncManualRangeState,
} from "./manualRanges.js";
import { createStrategies } from "../strategies/index.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] Unhandled promise rejection: ${formatError(reason)}`);
});

function colorize(symbol: string, color: string): string {
  return `${color}${formatConsoleSymbol(symbol)}${ANSI_RESET}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runOnceMode = process.argv.includes("--once");
  const marketDataClient = new HyperliquidClient(config.apiBaseUrl);
  const manualRanges = await loadManualRanges(config.manualRangeFile);
  const persistedStates = await loadManualRangeStates(config.manualRangeStateFile);
  const broker = createBroker(config);
  const strategies = createStrategies(config.activeStrategyId);
  const bot = new TradingBot(config, marketDataClient, broker, strategies);
  const brokerLogs = await broker.initialize();

  console.log(
    `[boot] Hyperliquid ${config.executionMode} bot started in ${runOnceMode ? "single-run" : config.runtimeMode} mode.`,
  );
  for (const logLine of brokerLogs) {
    console.log(`[boot] ${logLine}`);
  }
  console.log(
    `[boot] Watchlist ${formatConsoleSymbolList(config.watchlist)} | interval ${config.interval} | lookback ${config.rangeLookbackCandles} candles.`,
  );
  console.log(
    `[boot] Active strategy: ${wrapOrange(strategies.map((strategy) => strategy.id).join(", "))}.`,
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

    return `${colorize(symbol, ANSI_GREEN)} (${formatPerpPriceForConsole(manualRange.rangeLow)} - ${formatPerpPriceForConsole(manualRange.rangeHigh)})`;
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
    } catch (error) {
      console.error(`[bot] Cycle failed: ${formatError(error)}`);
      if (runOnceMode) {
        throw error;
      }
    } finally {
      cycleRunning = false;
    }
  };

  if (!runOnceMode && config.runtimeMode === "websocket") {
    const runner = new WebsocketRunner(config, marketDataClient, broker, bot);
    await runner.start();
    return;
  }

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
  console.error(`[fatal] ${formatError(error)}`);
  process.exit(1);
});
