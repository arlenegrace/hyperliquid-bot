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
  Candle,
  ManualRangeState,
  PaperBrokerSnapshot,
  TradingStrategy,
} from "../types.js";
import { buildRangeResearchReport } from "../analysis/rangeResearch.js";
import { createAllStrategies } from "../../strategies/index.js";

const RESEARCH_START_TIME = Date.UTC(2026, 0, 15, 0, 0, 0, 0);
const RESEARCH_END_TIME = Date.UTC(2026, 2, 10, 23, 59, 59, 999);

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
  signalDetections: Record<string, string[]>;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "Infinity";
}

function buildMarkPriceMap(markPrices: Map<string, number>): Record<string, number> {
  return Object.fromEntries(markPrices.entries());
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

function runBacktest(
  strategy: TradingStrategy,
  candlesBySymbol: Record<string, Candle[]>,
  manualRanges: ManualRangeMap,
  startingBalanceUsd: number,
  positionSizeUsd: number,
  feeRate: number,
  slippageRate: number,
): StrategyBacktestResult {
  const config = loadConfig();
  const broker = new PaperBroker(startingBalanceUsd, positionSizeUsd, {
    feeRate,
    slippageRate,
  });
  const symbols = Object.keys(candlesBySymbol);
  const markPrices = new Map<string, number>();
  const manualRangeStates = new Map<string, ManualRangeState>();
  const signalDetections: Record<string, string[]> = {};
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
      broker.processCandle(symbol, nextCandle);
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
      const manualRange = getManualRangeForSymbol(manualRanges, symbol);
      let manualRangeState = manualRange ? syncManualRangeState(manualRangeStates.get(symbol), manualRange) : undefined;

      if (manualRange && manualRangeState) {
        manualRangeState = refreshManualRangeTrackingFromCandles(manualRangeState, manualRange, candles);
      }

      if (manualRange && manualRangeState && latestCandle && latestCandle.closeTime >= (manualRange.validFromTime ?? 0)) {
        const invalidationResult = applyManualRangeInvalidation(manualRangeState, manualRange, latestCandle);
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
      const result = strategy.evaluate(strategyContext);

      for (const cancellation of result.positionCancellations ?? []) {
        broker.cancelPositionById(cancellation.positionId, latestCandle?.closeTime ?? timestamp, cancellation.reason, cancellation.note);
      }

      if (result.signal) {
        broker.openPosition(result.signal);

        if (result.signal.generatedAt >= RESEARCH_START_TIME && result.signal.generatedAt <= RESEARCH_END_TIME) {
          const detectionLabel = `${formatConsoleTimestamp(result.signal.generatedAt)} ${result.signal.side}`;
          signalDetections[symbol] = [...(signalDetections[symbol] ?? []), detectionLabel];
        }
      }
    }

    broker.recordEquity(buildMarkPriceMap(markPrices));
  }

  const lastTimestamp = timestamps.at(-1) ?? Date.now();
  broker.forceCloseAll(buildMarkPriceMap(markPrices), lastTimestamp, "backtest window completed");
  broker.recordEquity(buildMarkPriceMap(markPrices));

  const snapshot = broker.snapshot();
  return {
    summary: summarizeSnapshot(strategy.id, snapshot),
    signalDetections,
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

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new HyperliquidClient(config.apiBaseUrl);
  const manualRanges = await loadManualRanges(config.manualRangeFile);
  const symbols = [...new Set([...config.backtestSymbols, ...Object.keys(manualRanges)])];

  console.log(`[research] Fetching research candles for ${formatConsoleSymbolList(symbols)}.`);
  const researchLines = await buildRangeResearchReport(client, config, symbols);
  for (const line of researchLines) {
    console.log(`[research] ${line}`);
  }

  console.log(
    `[backtest] Fetching ${config.backtestLookbackCandles} recent 4h candles for ${formatConsoleSymbolList(symbols)}.`,
  );
  const candlesBySymbol = await fetchBacktestCandles(client, symbols, config.backtestLookbackCandles);
  const strategies = createAllStrategies();
  const results = strategies.map((strategy) =>
    runBacktest(
      strategy,
      candlesBySymbol,
      manualRanges,
      config.paperStartingBalanceUsd,
      config.paperPositionSizeUsd,
      config.backtestTradingFeeRate,
      config.backtestSlippageRate,
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

  const manualRangeResult = results.find((result) => result.summary.strategyId === "manual-range-trading");
  if (manualRangeResult) {
    console.log(
      `[backtest] Manual range detections during the ${formatConsoleSymbolList(symbols)} research window:`,
    );
    for (const symbol of symbols) {
      const detections = manualRangeResult.signalDetections[symbol] ?? [];
      console.log(
        detections.length > 0
          ? `[backtest] ${formatConsoleSymbol(symbol)} manual-range-trading detections: ${detections.join(", ")}`
          : `[backtest] ${formatConsoleSymbol(symbol)} manual-range-trading detections: none`,
      );
    }
  }

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
