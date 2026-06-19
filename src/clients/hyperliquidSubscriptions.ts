import { SubscriptionClient, WebSocketTransport, type ISubscription } from "@nktkas/hyperliquid";
import type { CandleEvent } from "@nktkas/hyperliquid/api/subscription";

import type {
  HyperliquidAccountPosition,
  HyperliquidAccountSnapshot,
  HyperliquidFill,
  HyperliquidOpenOrder,
} from "./hyperliquidExchange.js";
import type { Candle, CandleInterval, TradeSide } from "../types.js";

type OrderProcessingStatus =
  | "open"
  | "filled"
  | "canceled"
  | "triggered"
  | "rejected"
  | "marginCanceled"
  | "vaultWithdrawalCanceled"
  | "openInterestCapCanceled"
  | "selfTradeCanceled"
  | "reduceOnlyCanceled"
  | "siblingFilledCanceled"
  | "delistedCanceled"
  | "liquidatedCanceled"
  | "scheduledCancel"
  | "tickRejected"
  | "minTradeNtlRejected"
  | "perpMarginRejected"
  | "reduceOnlyRejected"
  | "badAloPxRejected"
  | "iocCancelRejected"
  | "badTriggerPxRejected"
  | "marketOrderNoLiquidityRejected"
  | "positionIncreaseAtOpenInterestCapRejected"
  | "positionFlipAtOpenInterestCapRejected"
  | "tooAggressiveAtOpenInterestCapRejected"
  | "openInterestIncreaseRejected"
  | "insufficientSpotBalanceRejected"
  | "oracleRejected"
  | "perpMaxPositionRejected";

export interface HyperliquidOrderUpdate {
  order: HyperliquidOpenOrder;
  status: OrderProcessingStatus;
  statusTimestamp: number;
}

export type HyperliquidAccountStreamEvent =
  | { type: "openOrders"; receivedAt: number; orders: HyperliquidOpenOrder[] }
  | { type: "orderUpdates"; receivedAt: number; updates: HyperliquidOrderUpdate[] }
  | { type: "fills"; receivedAt: number; isSnapshot: boolean; fills: HyperliquidFill[] }
  | { type: "clearinghouseState"; receivedAt: number; snapshot: HyperliquidAccountSnapshot }
  | { type: "fundings"; receivedAt: number; isSnapshot: boolean; fundings: Array<{ time: number; usdc: number }> }
  | { type: "subscriptionFailure"; receivedAt: number; feed: string; message: string };

interface HyperliquidSubscriptionGatewayOptions {
  useTestnet: boolean;
  timeoutMs: number;
}

function parseNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function normalizeTradeSide(side: "B" | "A"): TradeSide {
  return side === "B" ? "long" : "short";
}

function normalizeOpenOrder(order: {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  cloid?: `0x${string}` | null;
  reduceOnly?: boolean;
}): HyperliquidOpenOrder {
  return {
    symbol: order.coin.toUpperCase(),
    side: normalizeTradeSide(order.side),
    price: parseNumber(order.limitPx),
    sizeUnits: parseNumber(order.sz),
    reduceOnly: order.reduceOnly ?? false,
    orderId: order.oid,
    ...(order.cloid ? { clientOrderId: order.cloid } : {}),
    timestamp: order.timestamp,
  };
}

function normalizeFill(fill: {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  fee: string;
  closedPnl: string;
  oid: number;
  cloid?: `0x${string}`;
  time: number;
  tid: number;
}): HyperliquidFill {
  return {
    symbol: fill.coin.toUpperCase(),
    side: normalizeTradeSide(fill.side),
    price: parseNumber(fill.px),
    sizeUnits: parseNumber(fill.sz),
    feeUsd: Math.abs(parseNumber(fill.fee)),
    closedPnlUsd: parseNumber(fill.closedPnl),
    orderId: fill.oid,
    ...(fill.cloid ? { clientOrderId: fill.cloid } : {}),
    time: fill.time,
    tradeId: fill.tid,
  };
}

function normalizeCandle(candle: CandleEvent, expectedInterval: CandleInterval): Candle | undefined {
  if (candle.i !== expectedInterval) {
    return undefined;
  }

  return {
    openTime: candle.t,
    closeTime: candle.T,
    symbol: candle.s.toUpperCase(),
    interval: expectedInterval,
    open: parseNumber(candle.o),
    high: parseNumber(candle.h),
    low: parseNumber(candle.l),
    close: parseNumber(candle.c),
    volume: parseNumber(candle.v),
    trades: candle.n,
  };
}

function normalizeAccountSnapshot(state: {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      unrealizedPnl: string;
    };
  }>;
}): HyperliquidAccountSnapshot {
  const positionsBySymbol = new Map<string, HyperliquidAccountPosition>();
  for (const assetPosition of state.assetPositions) {
    const sizeUnitsSigned = parseNumber(assetPosition.position.szi);
    if (sizeUnitsSigned === 0) {
      continue;
    }

    positionsBySymbol.set(assetPosition.position.coin.toUpperCase(), {
      symbol: assetPosition.position.coin.toUpperCase(),
      side: sizeUnitsSigned > 0 ? "long" : "short",
      sizeUnits: Math.abs(sizeUnitsSigned),
      entryPrice: parseNumber(assetPosition.position.entryPx),
      unrealizedPnlUsd: parseNumber(assetPosition.position.unrealizedPnl),
    });
  }

  return {
    accountValueUsd: parseNumber(state.marginSummary.accountValue),
    withdrawableUsd: parseNumber(state.withdrawable),
    positionsBySymbol,
  };
}

export class HyperliquidSubscriptionGateway {
  private readonly transport: WebSocketTransport;
  private readonly client: SubscriptionClient;
  private readonly subscriptions: ISubscription[] = [];

  constructor(options: HyperliquidSubscriptionGatewayOptions) {
    this.transport = new WebSocketTransport({
      isTestnet: options.useTestnet,
      timeout: options.timeoutMs,
      reconnect: {
        maxRetries: Infinity,
        reconnectionDelay: 1_000,
      },
    });
    this.client = new SubscriptionClient({ transport: this.transport });
  }

  async subscribeCandles(
    symbols: string[],
    interval: CandleInterval,
    listener: (candle: Candle) => void,
    onFailure: (feed: string, reason: unknown) => void,
  ): Promise<void> {
    for (const symbol of symbols) {
      const normalizedSymbol = symbol.toUpperCase();
      const subscription = await this.client.candle({ coin: normalizedSymbol, interval }, (event) => {
        const candle = normalizeCandle(event, interval);
        if (candle) {
          listener(candle);
        }
      });
      this.trackSubscription(subscription, `candle:${normalizedSymbol}`, onFailure);
    }
  }

  async subscribeAccount(
    user: `0x${string}`,
    listener: (event: HyperliquidAccountStreamEvent) => void,
    onFailure: (feed: string, reason: unknown) => void,
  ): Promise<void> {
    const pushFailure = (feed: string, reason: unknown): void => {
      onFailure(feed, reason);
    };

    this.trackSubscription(
      await this.client.openOrders({ user }, (event) => {
        listener({
          type: "openOrders",
          receivedAt: Date.now(),
          orders: event.orders.map(normalizeOpenOrder),
        });
      }),
      "openOrders",
      pushFailure,
    );

    this.trackSubscription(
      await this.client.orderUpdates({ user }, (updates) => {
        listener({
          type: "orderUpdates",
          receivedAt: Date.now(),
          updates: updates.map((update) => ({
            order: normalizeOpenOrder(update.order),
            status: update.status as OrderProcessingStatus,
            statusTimestamp: update.statusTimestamp,
          })),
        });
      }),
      "orderUpdates",
      pushFailure,
    );

    this.trackSubscription(
      await this.client.userFills({ user }, (event) => {
        listener({
          type: "fills",
          receivedAt: Date.now(),
          isSnapshot: event.isSnapshot === true,
          fills: event.fills.map(normalizeFill),
        });
      }),
      "userFills",
      pushFailure,
    );

    this.trackSubscription(
      await this.client.clearinghouseState({ user }, (event) => {
        listener({
          type: "clearinghouseState",
          receivedAt: Date.now(),
          snapshot: normalizeAccountSnapshot(event.clearinghouseState),
        });
      }),
      "clearinghouseState",
      pushFailure,
    );

    this.trackSubscription(
      await this.client.userFundings({ user }, (event) => {
        listener({
          type: "fundings",
          receivedAt: Date.now(),
          isSnapshot: event.isSnapshot === true,
          fundings: event.fundings.map((funding) => ({
            time: funding.time,
            usdc: parseNumber(funding.usdc),
          })),
        });
      }),
      "userFundings",
      pushFailure,
    );
  }

  async close(): Promise<void> {
    const subscriptions = [...this.subscriptions];
    this.subscriptions.length = 0;

    const unsubscribeResults = await Promise.allSettled(
      subscriptions.map((subscription) => subscription.unsubscribe()),
    );
    for (const result of unsubscribeResults) {
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(`[ws] unsubscribe failed during close: ${message}`);
      }
    }

    try {
      await this.transport.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ws] transport close failed: ${message}`);
    }
  }

  private trackSubscription(
    subscription: ISubscription,
    feed: string,
    onFailure: (feed: string, reason: unknown) => void,
  ): void {
    this.subscriptions.push(subscription);

    let notified = false;
    const notifyFailure = (reason: unknown): void => {
      if (notified) {
        return;
      }

      notified = true;
      onFailure(feed, reason);
    };

    subscription.failureSignal.addEventListener("abort", () => {
      notifyFailure(subscription.failureSignal.reason);
    });

    if (subscription.failureSignal.aborted) {
      notifyFailure(subscription.failureSignal.reason);
    }
  }
}
