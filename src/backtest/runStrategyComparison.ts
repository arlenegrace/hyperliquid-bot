import { HyperliquidClient } from "../clients/hyperliquid.js";
import {
  formatConsoleSymbol,
  formatConsoleSymbolList,
  formatConsoleTimestamp,
} from "../consoleFormat.js";
import { loadConfig } from "../config.js";
import { PaperBroker } from "../engine/paperBroker.js";
import {
  applyManualRangeInvalidation,
  getManualRangeForSymbol,
  loadManualRanges,
  refreshManualRangeTrackingFromCandles,
  type ManualRangeMap,
  syncManualRangeState,
} from "../manualRanges.js";
import type {
  BrokerPosition,
  Candle,
  ManualRangeState,
  PaperBrokerSnapshot,
  TradingStrategy,
} from "../types.js";
import { buildRangeResearchReport } from "../analysis/rangeResearch.js";
import { createAllStrategies } from "../../strategies/index.js";

const RESEARCH_START_TIME = Date.UTC(2026, 2, 0, 0, 0, 0, 0);
const RESEARCH_END_TIME = Date.UTC(2027, 2, 28, 23, 59, 59, 999);

interface StrategyComparisonRow {
  strategyId: string;
  endingEquityUsd: number;
  realizedPnlUsd: number;
  maxDrawdownPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  profitFactor: number;
  cancelledPlans: number;
}

interface StrategyBacktestResult {
  summary: StrategyComparisonRow;
  filledTradeDetections: Record<string, string[]>;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "Infinity";
}

/** ANSI truecolor for manual-range detection lines (#4caf50 long, #f23645 short). */
const DETECTION_LONG_COLOR = "\x1b[38;2;76;175;80m";
const DETECTION_SHORT_COLOR = "\x1b[38;2;242;54;69m";
const DETECTION_COLOR_RESET = "\x1b[0m";

function ansiColorForDetectionLine(line: string): string {
  if (/\blong\b/.test(line)) return DETECTION_LONG_COLOR;
  if (/\bshort\b/.test(line)) return DETECTION_SHORT_COLOR;
  return "";
}

function buildMarkPriceMap(markPrices: Map<string, number>): Record<string, number> {
  return Object.fromEntries(markPrices.entries());
}

function buildEffectiveManualRangeMap(
  manualRanges: ManualRangeMap,
  tradingStartTime: number,
): ManualRangeMap {
  return Object.fromEntries(
    Object.entries(manualRanges).map(([symbol, range]) => [
      symbol,
      {
        ...range,
        validFromTime: Math.max(range.validFromTime ?? 0, tradingStartTime),
      },
    ]),
  );
}

function getFirstEntryFillTime(position: BrokerPosition): number | undefined {
  const fillTimes = position.entryOrders
    .map((order) => order.filledAt)
    .filter((filledAt): filledAt is number => typeof filledAt === "number");

  if (fillTimes.length === 0) {
    return undefined;
  }

  return Math.min(...fillTimes);
}

function collectFilledTradeDetections(
  snapshot: PaperBrokerSnapshot,
  strategyId: string,
  symbol: string,
  filledTradeDetections: Record<string, string[]>,
  loggedFilledPositionIds: Set<string>,
  tradingStartTimeMs: number,
): void {
  const candidatePositions = [
    ...snapshot.openPositions,
    ...snapshot.closedPositions,
    ...snapshot.cancelledPositions,
  ].filter((position) => position.symbol === symbol && position.strategyId === strategyId);

  for (const position of candidatePositions) {
    if (loggedFilledPositionIds.has(position.id)) {
      continue;
    }

    const firstFillTime = getFirstEntryFillTime(position);
    if (firstFillTime === undefined) {
      continue;
    }

    loggedFilledPositionIds.add(position.id);
    if (firstFillTime < tradingStartTimeMs || firstFillTime > RESEARCH_END_TIME) {
      continue;
    }

    const setup = position.setupKind !== undefined ? ` (${position.setupKind})` : "";
    const detectionLabel = `${formatConsoleTimestamp(firstFillTime)} ${position.side}${setup}`;
    filledTradeDetections[symbol] = [...(filledTradeDetections[symbol] ?? []), detectionLabel];
  }
}

async function fetchBacktestCandles(
  client: HyperliquidClient,
  symbols: string[],
  lookbackCandles: number,
): Promise<Record<string, Candle[]>> {
  const candlesBySymbol: Record<string, Candle[]> = {};

  for (const symbol of symbols) {
    candlesBySymbol[symbol] = await client.fetchRecentClosedCandles(symbol, "4h", lookbackCandles);
  }

  return candlesBySymbol;
}

async function runBacktest(
  strategy: TradingStrategy,
  candlesBySymbol: Record<string, Candle[]>,
  manualRanges: ManualRangeMap,
  startingBalanceUsd: number,
  positionSizeUsd: number,
  feeRate: number,
  slippageRate: number,
): Promise<StrategyBacktestResult> {
  const config = loadConfig();
  const tradingStartTimeMs = config.backtestTradingStartTimeMs;
  const broker = new PaperBroker(startingBalanceUsd, positionSizeUsd, {
    feeRate,
    slippageRate,
  });
  await broker.initialize();
  const effectiveManualRanges = buildEffectiveManualRangeMap(manualRanges, tradingStartTimeMs);
  const symbols = Object.keys(candlesBySymbol);
  const markPrices = new Map<string, number>();
  const manualRangeStates = new Map<string, ManualRangeState>();
  const filledTradeDetections: Record<string, string[]> = {};
  const loggedFilledPositionIds = new Set<string>();
  const timestamps = [
    ...new Set(
      symbols.flatMap((symbol) => (candlesBySymbol[symbol] ?? []).map((candle) => candle.closeTime)),
    ),
  ].sort((left, right) => left - right);
  const currentIndexes = Object.fromEntries(symbols.map((symbol) => [symbol, -1])) as Record<string, number>;

  for (const timestamp of timestamps) {
    const updatedSymbols: string[] = [];

    for (const symbol of symbols) {
      const currentIndex = currentIndexes[symbol] ?? -1;
      const nextIndex = currentIndex + 1;
      const symbolCandles = candlesBySymbol[symbol] ?? [];
      const nextCandle = symbolCandles[nextIndex];
      if (!nextCandle || nextCandle.closeTime !== timestamp) {
        continue;
      }

      currentIndexes[symbol] = nextIndex;
      markPrices.set(symbol, nextCandle.close);
      await broker.processCandle(symbol, nextCandle);
      collectFilledTradeDetections(
        broker.snapshot(),
        strategy.id,
        symbol,
        filledTradeDetections,
        loggedFilledPositionIds,
        tradingStartTimeMs,
      );
      updatedSymbols.push(symbol);
    }

    for (const symbol of updatedSymbols) {
      const currentIndex = currentIndexes[symbol] ?? -1;
      const symbolCandles = candlesBySymbol[symbol] ?? [];
      const candles = symbolCandles.slice(0, currentIndex + 1);
      if (candles.length < config.rangeLookbackCandles / 2) {
        continue;
      }

      const latestCandle = candles.at(-1);
      const manualRange = getManualRangeForSymbol(effectiveManualRanges, symbol);
      let manualRangeState = manualRange ? syncManualRangeState(manualRangeStates.get(symbol), manualRange) : undefined;

      if (manualRange && manualRangeState) {
        manualRangeState = refreshManualRangeTrackingFromCandles(manualRangeState, manualRange, candles);
      }

      if (manualRange && manualRangeState && latestCandle && latestCandle.closeTime >= (manualRange.validFromTime ?? 0)) {
        const invalidationResult = applyManualRangeInvalidation(
          manualRangeState,
          manualRange,
          latestCandle,
          config.manualRangeInvalidationExtendPct,
        );
        manualRangeState = invalidationResult.state;
        manualRangeStates.set(symbol, manualRangeState);
      } else if (!manualRange) {
        manualRangeStates.delete(symbol);
      }

      const strategyContext = {
        symbol,
        candles,
        config,
        hasOpenPosition: broker.hasOpenPosition(symbol, strategy.id),
        openPositions: broker.getOpenPositions(symbol, strategy.id),
        currentEquityUsd: broker.snapshot().equityUsd,
        ...(manualRange ? { manualRange } : {}),
        ...(manualRangeState ? { manualRangeState } : {}),
      };
      if (timestamp < tradingStartTimeMs) {
        continue;
      }
      const result = strategy.evaluate(strategyContext);

      for (const cancellation of result.positionCancellations ?? []) {
        await broker.cancelPositionById(
          cancellation.positionId,
          latestCandle?.closeTime ?? timestamp,
          cancellation.reason,
          cancellation.note,
        );
      }

      if (result.signal) {
        await broker.openPosition(result.signal);
        collectFilledTradeDetections(
          broker.snapshot(),
          strategy.id,
          symbol,
          filledTradeDetections,
          loggedFilledPositionIds,
          tradingStartTimeMs,
        );
      }
    }

    await broker.recordEquity(buildMarkPriceMap(markPrices));
  }

  const lastTimestamp = timestamps.at(-1) ?? Date.now();
  await broker.forceCloseAll(buildMarkPriceMap(markPrices), lastTimestamp, "backtest window completed");
  await broker.recordEquity(buildMarkPriceMap(markPrices));

  const snapshot = broker.snapshot();
  return {
    summary: summarizeSnapshot(strategy.id, snapshot),
    filledTradeDetections,
  };
}

function summarizeSnapshot(strategyId: string, snapshot: PaperBrokerSnapshot): StrategyComparisonRow {
  const profitFactor =
    snapshot.grossLossUsd === 0
      ? snapshot.grossProfitUsd > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : snapshot.grossProfitUsd / snapshot.grossLossUsd;

  return {
    strategyId,
    endingEquityUsd: snapshot.equityUsd,
    realizedPnlUsd: snapshot.realizedPnlUsd,
    maxDrawdownPct: snapshot.maxDrawdownPct,
    closedTrades: snapshot.closedPositions.length,
    wins: snapshot.wins,
    losses: snapshot.losses,
    profitFactor,
    cancelledPlans: snapshot.cancelledPositions.length,
  };
}

function rankResults(results: StrategyComparisonRow[]): StrategyComparisonRow[] {
  return [...results].sort((left, right) => {
    if (left.maxDrawdownPct !== right.maxDrawdownPct) {
      return left.maxDrawdownPct - right.maxDrawdownPct;
    }

    if (left.realizedPnlUsd !== right.realizedPnlUsd) {
      return right.realizedPnlUsd - left.realizedPnlUsd;
    }

    return right.profitFactor - left.profitFactor;
  });
}

function printFilledTradeDetectionsForStrategy(
  strategyResult: StrategyBacktestResult | undefined,
  strategyId: string,
  symbols: string[],
): void {
  if (!strategyResult) {
    return;
  }

  console.log(
    `[backtest] ${strategyId} filled trades during the ${formatConsoleSymbolList(symbols)} research window:`,
  );
  for (const symbol of symbols) {
    const detections = strategyResult.filledTradeDetections[symbol] ?? [];
    if (detections.length === 0) {
      console.log(`[backtest] ${formatConsoleSymbol(symbol)} ${strategyId} filled trades: none`);
      continue;
    }
    console.log(`[backtest] ${formatConsoleSymbol(symbol)} ${strategyId} filled trades:`);
    for (const line of detections) {
      const color = ansiColorForDetectionLine(line);
      const reset = color ? DETECTION_COLOR_RESET : "";
      console.log(`${color}   ${line}${reset}`);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new HyperliquidClient(config.apiBaseUrl);
  const manualRanges = await loadManualRanges(config.manualRangeFile);
  const symbols = [...new Set(config.backtestSymbols)];

  console.log(`[research] Fetching research candles for ${formatConsoleSymbolList(symbols)}.`);
  const researchLines = await buildRangeResearchReport(client, config, symbols);
  for (const line of researchLines) {
    console.log(`[research] ${line}`);
  }

  console.log(
    `[backtest] Fetching ${config.backtestLookbackCandles} recent 4h candles for ${formatConsoleSymbolList(symbols)}.`,
  );
  const candlesBySymbol = await fetchBacktestCandles(client, symbols, config.backtestLookbackCandles);
  const candleCounts = symbols
    .map((symbol) => `${formatConsoleSymbol(symbol)} ${(candlesBySymbol[symbol] ?? []).length}`)
    .join(", ");
  console.log(`[backtest] Closed 4h candle counts per symbol (API snapshot, not read from disk): ${candleCounts}.`);
  console.log(
    `[backtest] Manual range state is simulated in-memory from those candles only; ${config.manualRangeStateFile} is not loaded.`,
  );
  console.log(
    `[backtest] Strategy evaluation and order generation begin at ${formatConsoleTimestamp(config.backtestTradingStartTimeMs)}; earlier candles are warmup/history only.`,
  );
  const strategies = createAllStrategies();
  const results = await Promise.all(
    strategies.map((strategy) =>
      runBacktest(
      strategy,
      candlesBySymbol,
      manualRanges,
      config.paperStartingBalanceUsd,
      config.positionSizeUsd,
      config.backtestTradingFeeRate,
      config.backtestSlippageRate,
      ),
    ),
  );
  const rankedResults = rankResults(results.map((result) => result.summary));

  console.log("[backtest] Strategy comparison:");
  console.log(
    `[backtest] Using fee ${(config.backtestTradingFeeRate * 100).toFixed(3)}% per fill and slippage ${(config.backtestSlippageRate * 100).toFixed(3)}% per fill.`,
  );
  for (const result of rankedResults) {
    console.log(
      `[backtest] ${result.strategyId} | equity ${formatNumber(result.endingEquityUsd)} | pnl ${formatNumber(result.realizedPnlUsd)} | maxDD ${(result.maxDrawdownPct * 100).toFixed(2)}% | trades ${result.closedTrades} | wins ${result.wins} | losses ${result.losses} | PF ${formatNumber(result.profitFactor)} | cancelled ${result.cancelledPlans}`,
    );
  }

  printFilledTradeDetectionsForStrategy(
    results.find((result) => result.summary.strategyId === "manual-range-trading"),
    "manual-range-trading",
    symbols,
  );
  printFilledTradeDetectionsForStrategy(
    results.find((result) => result.summary.strategyId === "manual-range-trading-v1"),
    "manual-range-trading-v1",
    symbols,
  );
  printFilledTradeDetectionsForStrategy(
    results.find((result) => result.summary.strategyId === "manual-range-trading-v2"),
    "manual-range-trading-v2",
    symbols,
  );

  const winner = rankedResults[0];
  if (winner) {
    console.log(`[backtest] Winner by lower max drawdown, then return: ${winner.strategyId}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
