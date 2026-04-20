import { HyperliquidClient } from "../clients/hyperliquid.js";
import {
  formatBotCycleTimestamp,
  formatConsoleLabel,
  formatConsoleSymbolListGreen,
  formatConsoleTimestamp,
  formatPerpPriceForConsole,
  formatSignedUsdWithDollarPrefixColored,
  normalizeConsoleMessage,
  wrapRed,
} from "../consoleFormat.js";
import type { BotConfig, TradingStrategy } from "../types.js";
import {
  applyManualRangeInvalidation,
  loadManualRangeStates,
  getManualRangeForSymbol,
  loadManualRanges,
  refreshManualRangeTrackingFromCandles,
  saveManualRangeStates,
  type ManualRangeMap,
  syncManualRangeState,
} from "../manualRanges.js";
import type { Broker } from "./broker.js";

export class TradingBot {
  private readonly lastProcessedCloseTimeBySymbol = new Map<string, number>();
  private readonly manualRangeStates = new Map<string, import("../types.js").ManualRangeState>();
  private manualRangeStatesLoaded = false;

  constructor(
    private readonly config: BotConfig,
    private readonly marketDataClient: HyperliquidClient,
    private readonly broker: Broker,
    private readonly strategies: TradingStrategy[],
  ) {}

  async runOnce(): Promise<void> {
    await this.ensureManualRangeStatesLoaded();
    const manualRanges = await loadManualRanges(this.config.manualRangeFile);
    for (const logLine of await this.broker.onCycleStart()) {
      console.log(`[broker] ${logLine}`);
    }

    console.log(`[bot] Starting scan for ${formatConsoleSymbolListGreen(this.config.watchlist)} on ${this.config.interval} candles.`);
    console.log(`[bot] Loaded ${Object.keys(manualRanges).length} manual ranges from ${this.config.manualRangeFile}.`);

    for (const symbol of this.config.watchlist) {
      await this.processSymbol(symbol, manualRanges);
    }

    await this.broker.prepareSnapshot();
    const snapshot = this.broker.snapshot();
    console.log(
      `[bot] ${formatBotCycleTimestamp()}: Cycle finished. Open positions: ${snapshot.openPositions.length}, closed positions: ${snapshot.closedPositions.length}, unrealized PnL: ${formatSignedUsdWithDollarPrefixColored(snapshot.unrealizedPnlUsd, { suffix: " USD" })}, all time PnL: ${formatSignedUsdWithDollarPrefixColored(snapshot.allTimePnlUsd, { suffix: "" })}, account equity: $${snapshot.equityUsd.toFixed(2)}.`,
    );
    await saveManualRangeStates(this.config.manualRangeStateFile, this.manualRangeStates);
  }

  private async processSymbol(symbol: string, manualRanges: ManualRangeMap): Promise<void> {
    try {
      const candles = await this.marketDataClient.fetchRecentClosedCandles(
        symbol,
        this.config.interval,
        this.config.rangeLookbackCandles + 2,
      );

      const latestClosedCandle = candles.at(-1);
      if (!latestClosedCandle) {
        console.log(`${formatConsoleLabel(symbol)} No closed candles returned from Hyperliquid.`);
        return;
      }

      const manualRange = getManualRangeForSymbol(manualRanges, symbol);
      let manualRangeState = manualRange ? syncManualRangeState(this.manualRangeStates.get(symbol), manualRange) : undefined;

      const lastProcessedCloseTime = this.lastProcessedCloseTimeBySymbol.get(symbol);
      if (lastProcessedCloseTime === latestClosedCandle.closeTime) {
        if (manualRangeState?.isInvalidated) {
          console.log(`${formatConsoleLabel(symbol)} ${wrapRed("Range has been invalidated.")}`);
        } else {
          console.log(`${formatConsoleLabel(symbol)} No new closed ${this.config.interval} candle yet.`);
        }
        return;
      }

      console.log(
        `${formatConsoleLabel(symbol)} Loaded ${candles.length} closed candles. Latest close ${formatPerpPriceForConsole(latestClosedCandle.close)} at ${formatConsoleTimestamp(latestClosedCandle.closeTime)}.`,
      );

      for (const logLine of await this.broker.processCandle(symbol, latestClosedCandle)) {
        console.log(`${formatConsoleLabel(symbol)} ${normalizeConsoleMessage(symbol, logLine)}`);
      }

      if (manualRange && manualRangeState) {
        manualRangeState = refreshManualRangeTrackingFromCandles(manualRangeState, manualRange, candles);
      }

      if (manualRange && manualRangeState && latestClosedCandle.closeTime >= (manualRange.validFromTime ?? 0)) {
        const invalidationResult = applyManualRangeInvalidation(
          manualRangeState,
          manualRange,
          latestClosedCandle,
          this.config.manualRangeInvalidationExtendPct,
        );
        manualRangeState = invalidationResult.state;
        this.manualRangeStates.set(symbol, manualRangeState);
      } else if (!manualRange) {
        this.manualRangeStates.delete(symbol);
      }

      for (const strategy of this.strategies) {
        const snapshot = this.broker.snapshot();
        const openPositions = this.broker.getOpenPositions(symbol, strategy.id);
        const strategyContext = {
          symbol,
          candles,
          config: this.config,
          hasOpenPosition: openPositions.length > 0,
          openPositions,
          currentEquityUsd: snapshot.equityUsd,
          ...(manualRange ? { manualRange } : {}),
          ...(manualRangeState ? { manualRangeState } : {}),
        };
        const result = strategy.evaluate(strategyContext);

        for (const note of result.notes) {
          const body = manualRangeState?.isInvalidated
            ? wrapRed(normalizeConsoleMessage(symbol, note))
            : normalizeConsoleMessage(symbol, note);
          console.log(`${formatConsoleLabel(symbol)} ${body}`);
        }

        for (const cancellation of result.positionCancellations ?? []) {
          for (const logLine of await this.broker.cancelPositionById(
            cancellation.positionId,
            latestClosedCandle.closeTime,
            cancellation.reason,
            cancellation.note,
          )) {
            console.log(`${formatConsoleLabel(symbol)} ${normalizeConsoleMessage(symbol, logLine)}`);
          }
        }

        if (!result.signal) {
          continue;
        }

        for (const logLine of await this.broker.openPosition(result.signal)) {
          console.log(`${formatConsoleLabel(symbol)} ${normalizeConsoleMessage(symbol, logLine)}`);
        }
      }

      await this.broker.recordEquity({ [symbol]: latestClosedCandle.close });
      this.lastProcessedCloseTimeBySymbol.set(symbol, latestClosedCandle.closeTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${formatConsoleLabel(symbol)} Failed to process symbol: ${message}`);
    }
  }

  private async ensureManualRangeStatesLoaded(): Promise<void> {
    if (this.manualRangeStatesLoaded) {
      return;
    }

    const persistedStates = await loadManualRangeStates(this.config.manualRangeStateFile);
    for (const [symbol, state] of persistedStates.entries()) {
      this.manualRangeStates.set(symbol, state);
    }

    this.manualRangeStatesLoaded = true;
  }
}
