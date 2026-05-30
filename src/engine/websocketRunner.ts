import { formatConsoleSymbolListGreen } from "../consoleFormat.js";
import { HyperliquidClient } from "../clients/hyperliquid.js";
import {
  HyperliquidSubscriptionGateway,
  type HyperliquidAccountStreamEvent,
} from "../clients/hyperliquidSubscriptions.js";
import type { BotConfig, Candle } from "../types.js";
import { CandleStore } from "./candleStore.js";
import type { Broker } from "./broker.js";
import { HyperliquidLiveBroker } from "./liveBroker.js";
import { TradingBot } from "./bot.js";

export class WebsocketRunner {
  private readonly candleStore: CandleStore;
  private readonly subscriptionGateway: HyperliquidSubscriptionGateway;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private processing = false;
  private stopping = false;

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
    this.subscriptionGateway = new HyperliquidSubscriptionGateway({
      useTestnet: config.live.useTestnet,
      timeoutMs: config.live.orderTimeoutMs,
    });
  }

  async start(): Promise<void> {
    await this.bootstrapCandles();
    await this.subscribeStreams();
    this.startStalenessMonitor();

    console.log(
      `[boot] Websocket runtime active for ${formatConsoleSymbolListGreen(this.config.watchlist)}; REST is now reserved for bootstrap, reconnect recovery, write fallback, and sparse safety reconciliation.`,
    );

    await new Promise<void>((resolve) => {
      const shutdown = async (): Promise<void> => {
        if (this.stopping) {
          return;
        }

        this.stopping = true;
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
        }
        if (this.staleTimer) {
          clearInterval(this.staleTimer);
        }

        console.log("[boot] Shutdown requested. Closing websocket subscriptions.");
        await this.subscriptionGateway.close();
        resolve();
      };

      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
  }

  private async bootstrapCandles(): Promise<void> {
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const symbol of this.config.watchlist) {
      const candles = await this.marketDataClient.fetchRecentClosedCandles(
        symbol,
        this.config.interval,
        this.config.rangeLookbackCandles + 2,
      );
      this.candleStore.seed(symbol, candles);
      candlesBySymbol.set(symbol, candles);
    }

    await this.bot.runForClosedCandles(candlesBySymbol);
    for (const [symbol, candles] of candlesBySymbol.entries()) {
      const latest = candles.at(-1);
      if (latest) {
        this.candleStore.markProcessed(symbol, latest.closeTime);
      }
    }
  }

  private async subscribeStreams(): Promise<void> {
    await this.subscriptionGateway.subscribeCandles(
      this.config.watchlist,
      this.config.interval,
      (candle) => {
        this.candleStore.upsertFromStream(candle);
        this.scheduleFlush();
      },
      (feed, reason) => {
        console.error(`[ws] ${feed} subscription failed: ${reason instanceof Error ? reason.message : String(reason)}`);
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
        (event: HyperliquidAccountStreamEvent) => liveBroker.enqueueRemoteEvent(event),
        (feed, reason) => liveBroker.markRemoteSubscriptionFailed(feed, reason),
      );
    }
  }

  private scheduleFlush(): void {
    if (this.stopping) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushClosedCandles();
    }, this.config.websocket.candleBatchDebounceMs);
  }

  private async flushClosedCandles(): Promise<void> {
    if (this.processing) {
      this.scheduleFlush();
      return;
    }

    const ready = this.candleStore.collectNewClosedCandles();
    if (ready.size === 0) {
      return;
    }

    const candlesBySymbol = new Map<string, Candle[]>();
    for (const symbol of ready.keys()) {
      candlesBySymbol.set(symbol, this.candleStore.getCandles(symbol));
    }

    this.processing = true;
    try {
      await this.bot.runForClosedCandles(candlesBySymbol);
    } finally {
      this.processing = false;
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
