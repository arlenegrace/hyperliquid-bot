import { formatConsoleSymbolListGreen } from "../consoleFormat.js";
import { HyperliquidClient } from "../clients/hyperliquid.js";
import {
  HyperliquidSubscriptionGateway,
  type HyperliquidAccountStreamEvent,
} from "../clients/hyperliquidSubscriptions.js";
import { loadCandleCache, saveCandleCache } from "../candleCache.js";
import type { BotConfig, Candle } from "../types.js";
import { CandleStore } from "./candleStore.js";
import type { Broker } from "./broker.js";
import { HyperliquidLiveBroker } from "./liveBroker.js";
import { TradingBot } from "./bot.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const RESUBSCRIBE_BASE_DELAY_MS = 5_000;
const RESUBSCRIBE_MAX_DELAY_MS = 120_000;

function formatStreamError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getDelayUntilNextCandleCloseGrace(now: number, graceMs: number): number {
  const nextCloseTime = Math.ceil((now + 1) / FOUR_HOURS_MS) * FOUR_HOURS_MS - 1;
  return Math.max(0, nextCloseTime + graceMs - now);
}

export class WebsocketRunner {
  private readonly candleStore: CandleStore;
  private subscriptionGateway: HyperliquidSubscriptionGateway;
  private candleCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private resubscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private processing = false;
  private stopping = false;
  private resubscribeAttempts = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly marketDataClient: HyperliquidClient,
    private readonly broker: Broker,
    private readonly bot: TradingBot,
  ) {
    this.candleStore = new CandleStore({
      interval: config.interval,
      maxCandlesPerSymbol: config.rangeLookbackCandles + 2,
      candleCloseGraceMs: config.websocket.candleCloseGraceMs,
    });
    this.subscriptionGateway = this.createSubscriptionGateway();
  }

  async start(): Promise<void> {
    await this.bootstrapCandles();
    await this.subscribeStreams();
    this.scheduleNextCandleClose();
    this.startStalenessMonitor();

    console.log(
      `[boot] Websocket runtime active for ${formatConsoleSymbolListGreen(this.config.watchlist)}; REST confirms each 4h candle after a ${this.config.websocket.candleCloseGraceMs}ms close grace.`,
    );

    await new Promise<void>((resolve) => {
      const shutdown = async (): Promise<void> => {
        if (this.stopping) {
          return;
        }

        this.stopping = true;
        if (this.candleCloseTimer) {
          clearTimeout(this.candleCloseTimer);
        }
        if (this.staleTimer) {
          clearInterval(this.staleTimer);
        }
        if (this.resubscribeTimer) {
          clearTimeout(this.resubscribeTimer);
        }

        console.log("[boot] Shutdown requested. Closing websocket subscriptions.");
        try {
          await this.subscriptionGateway.close();
        } catch (error) {
          console.error(`[boot] Failed to close websocket subscriptions: ${formatStreamError(error)}`);
        }
        resolve();
      };

      process.once("SIGINT", () => {
        void shutdown().catch((error) => {
          console.error(`[boot] Shutdown failed: ${formatStreamError(error)}`);
          resolve();
        });
      });
      process.once("SIGTERM", () => {
        void shutdown().catch((error) => {
          console.error(`[boot] Shutdown failed: ${formatStreamError(error)}`);
          resolve();
        });
      });
    });
  }

  private createSubscriptionGateway(): HyperliquidSubscriptionGateway {
    return new HyperliquidSubscriptionGateway({
      useTestnet: this.config.live.useTestnet,
      timeoutMs: this.config.live.orderTimeoutMs,
    });
  }

  private get candleCachePath(): string {
    return this.config.live.stateFile.replace(/\.json$/, "") + ".candle-cache.json";
  }

  private async bootstrapCandles(): Promise<void> {
    const candlesBySymbol = new Map<string, Candle[]>();
    let usedCache = false;

    try {
      for (const symbol of this.config.watchlist) {
        const candles = await this.marketDataClient.fetchRecentClosedCandles(
          symbol,
          this.config.interval,
          this.config.rangeLookbackCandles + 2,
        );
        this.candleStore.seed(symbol, candles);
        candlesBySymbol.set(symbol, candles);
      }
      await saveCandleCache(this.candleCachePath, candlesBySymbol);
    } catch (error) {
      const message = formatStreamError(error);
      console.error(`[boot] REST bootstrap failed: ${message}. Attempting to load from local candle cache.`);

      const cached = await loadCandleCache(this.candleCachePath);
      if (cached.size === 0) {
        throw new Error(`REST bootstrap failed and no local candle cache is available. Original error: ${message}`);
      }

      candlesBySymbol.clear();
      for (const symbol of this.config.watchlist) {
        const candles = cached.get(symbol.toUpperCase());
        if (candles && candles.length > 0) {
          this.candleStore.seed(symbol, candles);
          candlesBySymbol.set(symbol, candles);
        } else {
          console.warn(`[boot] No cached candles for ${symbol}. This symbol will be skipped until the next REST candle close cycle.`);
        }
      }
      usedCache = true;
      console.log(`[boot] Loaded ${candlesBySymbol.size} symbol(s) from local candle cache.`);
    }

    await this.bot.runForClosedCandles(candlesBySymbol);
    for (const [symbol, candles] of candlesBySymbol.entries()) {
      const latest = candles.at(-1);
      if (latest) {
        this.candleStore.markProcessed(symbol, latest.closeTime);
      }
    }

    if (usedCache) {
      console.warn("[boot] Bootstrap used cached candles. Data may be stale — the next 4h candle close cycle will fetch fresh data from the exchange.");
    }
  }

  private async subscribeStreams(): Promise<void> {
    await this.subscriptionGateway.subscribeCandles(
      this.config.watchlist,
      this.config.interval,
      (candle) => {
        try {
          this.candleStore.upsertFromStream(candle);
        } catch (error) {
          console.error(`[ws] Failed to process candle stream event: ${formatStreamError(error)}`);
        }
      },
      (feed, reason) => {
        console.error(`[ws] ${feed} subscription failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        this.scheduleResubscribe(`${feed} subscription failed`);
      },
    );

    const liveBroker = this.broker instanceof HyperliquidLiveBroker ? this.broker : undefined;
    if (liveBroker) {
      const accountAddress = liveBroker.getAccountAddress();
      if (!accountAddress) {
        return;
      }

      await this.subscriptionGateway.subscribeAccount(
        accountAddress,
        (event: HyperliquidAccountStreamEvent) => {
          try {
            liveBroker.enqueueRemoteEvent(event);
          } catch (error) {
            console.error(`[ws] Failed to enqueue account stream event: ${formatStreamError(error)}`);
          }
        },
        (feed, reason) => {
          liveBroker.markRemoteSubscriptionFailed(feed, reason);
          this.scheduleResubscribe(`${feed} subscription failed`);
        },
      );
    }

    this.subscriptionGateway.onTransportTermination((reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(`[ws] WebSocket transport terminated: ${message}`);
      const liveBroker = this.broker instanceof HyperliquidLiveBroker ? this.broker : undefined;
      if (liveBroker) {
        liveBroker.markRemoteSubscriptionFailed("transport", reason);
      }
      this.scheduleResubscribe("transport terminated");
    });
  }

  private scheduleResubscribe(reason: string): void {
    if (this.stopping || this.resubscribeTimer) {
      return;
    }

    const delayMs = Math.min(
      RESUBSCRIBE_BASE_DELAY_MS * Math.pow(2, this.resubscribeAttempts),
      RESUBSCRIBE_MAX_DELAY_MS,
    );
    this.resubscribeAttempts += 1;

    console.log(`[ws] Scheduling resubscribe in ${Math.round(delayMs / 1000)}s (attempt ${this.resubscribeAttempts}, reason: ${reason}).`);

    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = undefined;
      void this.attemptResubscribe();
    }, delayMs);
  }

  private async attemptResubscribe(): Promise<void> {
    if (this.stopping) {
      return;
    }

    console.log("[ws] Attempting to resubscribe all streams...");
    try {
      try {
        await this.subscriptionGateway.close();
      } catch {
        // Ignore close errors during resubscribe — we're creating a fresh gateway.
      }
      this.subscriptionGateway = this.createSubscriptionGateway();
      await this.subscribeStreams();
      this.resubscribeAttempts = 0;
      console.log("[ws] Resubscribe succeeded. All streams are active.");
    } catch (error) {
      console.error(`[ws] Resubscribe failed: ${formatStreamError(error)}`);
      this.scheduleResubscribe("resubscribe attempt failed");
    }
  }

  private scheduleNextCandleClose(now = Date.now()): void {
    if (this.stopping) {
      return;
    }

    if (this.candleCloseTimer) {
      clearTimeout(this.candleCloseTimer);
    }

    this.candleCloseTimer = setTimeout(() => {
      this.candleCloseTimer = undefined;
      void this.processConfirmedClosedCandles();
    }, getDelayUntilNextCandleCloseGrace(now, this.config.websocket.candleCloseGraceMs));
  }

  private async processConfirmedClosedCandles(): Promise<void> {
    if (this.processing) {
      this.scheduleNextCandleClose();
      return;
    }

    const candlesBySymbol = new Map<string, Candle[]>();
    this.processing = true;
    try {
      for (const symbol of this.config.watchlist) {
        const candles = await this.marketDataClient.fetchRecentClosedCandles(
          symbol,
          this.config.interval,
          this.config.rangeLookbackCandles + 2,
        );
        this.candleStore.seed(symbol, candles);
        candlesBySymbol.set(symbol, candles);
      }

      await saveCandleCache(this.candleCachePath, candlesBySymbol);
      await this.bot.runForClosedCandles(candlesBySymbol);
      for (const [symbol, candles] of candlesBySymbol.entries()) {
        const latest = candles.at(-1);
        if (latest) {
          this.candleStore.markProcessed(symbol, latest.closeTime);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ws] Candle close cycle failed (will retry next cycle): ${message}`);
    } finally {
      this.processing = false;
      this.scheduleNextCandleClose();
    }
  }

  private startStalenessMonitor(): void {
    this.staleTimer = setInterval(() => {
      const now = Date.now();
      for (const symbol of this.config.watchlist) {
        const latestEventTime = this.candleStore.getLatestEventTime(symbol);
        if (latestEventTime === undefined) {
          continue;
        }

        if (now - latestEventTime > this.config.websocket.marketDataStaleMs) {
          console.warn(
            `[ws] ${symbol}: candle stream has been quiet for ${Math.round((now - latestEventTime) / 1000)}s; entries wait for the next confirmed closed candle.`,
          );
        }
      }
    }, Math.max(60_000, this.config.websocket.marketDataStaleMs));
  }
}
