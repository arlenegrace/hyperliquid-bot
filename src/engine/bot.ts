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
import type { BotConfig, Candle, ManualRangeDefinition, ManualRangeState, TradingStrategy } from "../types.js";
import {
  applyManualRangeInvalidation,
  getManualRangeMapFingerprint,
  loadManualRangeStates,
  getManualRangeForSymbol,
  loadManualRanges,
  refreshManualRangeTrackingFromCandles,
  saveManualRangeStates,
  type ManualRangeMap,
  syncManualRangeState,
} from "../manualRanges.js";
import type { Broker } from "./broker.js";

type ManualRangeReloadTrigger = "poll-cycle" | "websocket-4h-candle";

export class TradingBot {
  private readonly lastProcessedCloseTimeBySymbol = new Map<string, number>();
  private readonly manualRangeStates = new Map<string, ManualRangeState>();
  private manualRangeStatesLoaded = false;
  private lastLoadedManualRangeFingerprint: string | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly marketDataClient: HyperliquidClient,
    private readonly broker: Broker,
    private readonly strategies: TradingStrategy[],
  ) {}

  async runOnce(): Promise<void> {
    await this.ensureManualRangeStatesLoaded();
    const manualRanges = await this.reloadManualRanges("poll-cycle");
    for (const logLine of await this.broker.onCycleStart()) {
      console.log(`[broker] ${logLine}`);
    }

    console.log(`[bot] Starting scan for ${formatConsoleSymbolListGreen(this.config.watchlist)} on ${this.config.interval} candles.`);

    for (const symbol of this.config.watchlist) {
      await this.processSymbolFromRest(symbol, manualRanges);
    }

    await this.logCycleSummary();
    await saveManualRangeStates(this.config.manualRangeStateFile, this.manualRangeStates);
  }

  async runForClosedCandles(candlesBySymbol: Map<string, Candle[]>): Promise<void> {
    await this.ensureManualRangeStatesLoaded();
    const manualRanges = await this.reloadManualRanges("websocket-4h-candle");
    for (const logLine of await this.broker.onCycleStart()) {
      console.log(`[broker] ${logLine}`);
    }

    const symbols = this.config.watchlist.filter((symbol) => candlesBySymbol.has(symbol));
    if (symbols.length === 0) {
      return;
    }

    console.log(`[bot] Processing websocket candle close for ${formatConsoleSymbolListGreen(symbols)}.`);

    for (const symbol of symbols) {
      const candles = candlesBySymbol.get(symbol);
      if (!candles) {
        continue;
      }

      await this.processSymbolCandles(symbol, candles, manualRanges);
    }

    await this.logCycleSummary();
    await saveManualRangeStates(this.config.manualRangeStateFile, this.manualRangeStates);
  }

  getLastProcessedCloseTime(symbol: string): number | undefined {
    return this.lastProcessedCloseTimeBySymbol.get(symbol.toUpperCase());
  }

  private async processSymbolFromRest(symbol: string, manualRanges: ManualRangeMap): Promise<void> {
    try {
      const candles = await this.marketDataClient.fetchRecentClosedCandles(
        symbol,
        this.config.interval,
        this.config.rangeLookbackCandles + 2,
      );

      await this.processSymbolCandles(symbol, candles, manualRanges);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${formatConsoleLabel(symbol)} Failed to process symbol: ${message}`);
    }
  }

  private async processSymbolCandles(symbol: string, candles: Candle[], manualRanges: ManualRangeMap): Promise<void> {
    try {
      const latestClosedCandle = candles.at(-1);
      if (!latestClosedCandle) {
        console.log(`${formatConsoleLabel(symbol)} No closed candles returned from Hyperliquid.`);
        return;
      }

      const manualRange = getManualRangeForSymbol(manualRanges, symbol);
      let manualRangeState = manualRange ? syncManualRangeState(this.manualRangeStates.get(symbol), manualRange) : undefined;

      const lastProcessedCloseTime = this.lastProcessedCloseTimeBySymbol.get(symbol);
      if (lastProcessedCloseTime === latestClosedCandle.closeTime) {
        if (manualRange && manualRangeState) {
          this.persistReloadedManualRangeState(symbol, manualRange, manualRangeState);
        } else if (!manualRange) {
          this.manualRangeStates.delete(symbol);
        }

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
      this.lastProcessedCloseTimeBySymbol.set(symbol.toUpperCase(), latestClosedCandle.closeTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${formatConsoleLabel(symbol)} Failed to process symbol: ${message}`);
    }
  }

  private async logCycleSummary(): Promise<void> {
    await this.broker.prepareSnapshot();
    const snapshot = this.broker.snapshot();
    console.log(
      `[bot] ${formatBotCycleTimestamp()}: Cycle finished. Open positions: ${snapshot.openPositions.length}, closed positions: ${snapshot.closedPositions.length}, unrealized PnL: ${formatSignedUsdWithDollarPrefixColored(snapshot.unrealizedPnlUsd, { suffix: " USD" })}, all time PnL: ${formatSignedUsdWithDollarPrefixColored(snapshot.allTimePnlUsd, { suffix: "" })}, account equity: $${snapshot.equityUsd.toFixed(2)}.`,
    );
  }

  private async reloadManualRanges(trigger: ManualRangeReloadTrigger): Promise<ManualRangeMap> {
    const manualRanges = await loadManualRanges(this.config.manualRangeFile);
    const fingerprint = getManualRangeMapFingerprint(manualRanges);
    const triggerLabel = trigger === "websocket-4h-candle" ? "4h websocket candle close" : "poll cycle";

    console.log(
      `[bot] Reloaded ${Object.keys(manualRanges).length} manual ranges from ${this.config.manualRangeFile} (${triggerLabel}).`,
    );

    if (
      this.lastLoadedManualRangeFingerprint !== undefined &&
      this.lastLoadedManualRangeFingerprint !== fingerprint
    ) {
      console.log("[bot] Manual range definitions changed since the previous reload.");
    }

    this.lastLoadedManualRangeFingerprint = fingerprint;
    return manualRanges;
  }

  private persistReloadedManualRangeState(
    symbol: string,
    manualRange: ManualRangeDefinition,
    manualRangeState: ManualRangeState,
  ): void {
    const previousState = this.manualRangeStates.get(symbol);
    if (previousState?.fingerprint === manualRangeState.fingerprint) {
      return;
    }

    this.manualRangeStates.set(symbol, manualRangeState);
    console.log(
      `${formatConsoleLabel(symbol)} Manual range reloaded (${formatPerpPriceForConsole(manualRange.rangeLow)} - ${formatPerpPriceForConsole(manualRange.rangeHigh)}).`,
    );
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
