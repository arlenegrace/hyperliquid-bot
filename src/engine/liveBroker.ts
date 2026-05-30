import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HyperliquidExchangeGateway,
  type HyperliquidCancelOrderRequest,
  type HyperliquidCancelOrderResult,
  type HyperliquidAccountSnapshot,
  type HyperliquidFill,
  type HyperliquidOpenOrder,
  type HyperliquidPlaceOrderSpec,
} from "../clients/hyperliquidExchange.js";
import type { HyperliquidAccountStreamEvent, HyperliquidOrderUpdate } from "../clients/hyperliquidSubscriptions.js";
import type {
  BotConfig,
  BrokerPosition,
  BrokerSnapshot,
  Candle,
  PositionEntryOrder,
  PositionExitOrder,
  PositionStopOrder,
  StrategySignal,
  TradeSide,
} from "../types.js";
import { wrapOrange } from "../consoleFormat.js";
import type { Broker } from "./broker.js";
import {
  allocatePrioritizedExitOrderTargets,
  buildPlannedEntryOrders,
  calculatePlannedEntryNotionalUsd,
} from "./liveGuardrails.js";

const POSITION_EPSILON = 1e-9;
const PROCESSED_TRADE_ID_LIMIT = 5_000;
const MIN_TAKE_PROFIT_ORDER_NOTIONAL_USD = 10;
type TrackedPositionOrder = PositionEntryOrder | PositionExitOrder | PositionStopOrder;

interface LiveBrokerStateFile {
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeesUsd: number;
  wins: number;
  losses: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  nextPositionSequence: number;
  lastSyncTime: number;
  processedTradeIds: number[];
  lastMarks: Record<string, number>;
  openPositions: BrokerPosition[];
  closedPositions: BrokerPosition[];
  cancelledPositions: BrokerPosition[];
}

interface CancelExchangeOrdersResult {
  logs: string[];
  trackedResults: Array<{
    request: HyperliquidCancelOrderRequest;
    order: TrackedPositionOrder;
    result: HyperliquidCancelOrderResult;
  }>;
}

function calculatePnlUsd(side: TradeSide, entryPrice: number, exitPrice: number, sizeUnits: number): number {
  if (side === "long") {
    return (exitPrice - entryPrice) * sizeUnits;
  }

  return (entryPrice - exitPrice) * sizeUnits;
}

function clonePosition(position: BrokerPosition): BrokerPosition {
  return {
    ...position,
    entryOrders: position.entryOrders.map((order) => ({ ...order })),
    exitOrders: position.exitOrders.map((order) => ({ ...order })),
    ...(position.stopOrder ? { stopOrder: { ...position.stopOrder } } : {}),
    ...(position.metadata ? { metadata: { ...position.metadata } } : {}),
  };
}

function weightedAverage(currentSize: number, currentAverage: number | undefined, deltaSize: number, deltaPrice: number): number {
  const currentNotional = (currentAverage ?? 0) * currentSize;
  return (currentNotional + deltaSize * deltaPrice) / (currentSize + deltaSize);
}

function resolveStatePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function isSameNumber(left: number | undefined, right: number | undefined, tolerance = 1e-6): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return Math.abs(left - right) <= tolerance;
}

function isOrderSideBuy(side: TradeSide): boolean {
  return side === "long";
}

function oppositeTradeSide(side: TradeSide): TradeSide {
  return side === "long" ? "short" : "long";
}

function toClientOrderId(seed: string): `0x${string}` {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `0x${hash}` as `0x${string}`;
}

function resolveCancelledOrderStatus(order: { filledSizeUnits?: number }): "filled" | "cancelled" {
  return (order.filledSizeUnits ?? 0) > POSITION_EPSILON ? "filled" : "cancelled";
}

export class HyperliquidLiveBroker implements Broker {
  readonly mode = "live" as const;

  private readonly gateway: HyperliquidExchangeGateway;
  private readonly openPositions = new Map<string, BrokerPosition>();
  private readonly closedPositions: BrokerPosition[] = [];
  private readonly cancelledPositions: BrokerPosition[] = [];
  private readonly lastMarks = new Map<string, number>();
  private readonly lastExchangeUnrealizedBySymbol = new Map<string, number>();
  private readonly processedTradeIds = new Set<number>();

  private accountAddress?: `0x${string}`;
  private currentAccountValueUsd?: number;
  private startingBalanceUsd = 0;
  private realizedPnlUsd = 0;
  private grossProfitUsd = 0;
  private grossLossUsd = 0;
  private totalFeesUsd = 0;
  private wins = 0;
  private losses = 0;
  private peakEquityUsd = 0;
  private maxDrawdownPct = 0;
  private nextPositionSequence = 1;
  private lastSyncTime = 0;
  private openExchangeOrderIds = new Set<`0x${string}`>();
  private openExchangeOrderOids = new Set<number>();
  private initialized = false;
  private remoteStreamFailedReason: string | undefined;
  private lastAccountStreamEventAt = 0;
  private lastFullReconcileAt = 0;
  private readonly remoteEventQueue: HyperliquidAccountStreamEvent[] = [];
  private readonly remoteEventWaiters: Array<() => void> = [];
  /** Cumulative net funding from `userFunding` (refreshed each prepareSnapshot). */
  private lifetimeFundingUsd = 0;
  /** Latest `allTime` portfolio PnL from the exchange (prepareSnapshot). */
  private portfolioAllTimePnlUsd = 0;
  private nextProtectiveOrderSequence = 1;

  constructor(
    private readonly config: BotConfig,
    apiBaseUrl: string,
  ) {
    this.gateway = new HyperliquidExchangeGateway(apiBaseUrl, config.live);
  }

  async initialize(): Promise<string[]> {
    if (this.initialized) {
      return [];
    }

    await this.gateway.initialize();
    this.accountAddress = this.gateway.validateAccountAddress(this.config.live.accountAddress);
    await this.loadState();

    const accountSnapshot = await this.gateway.fetchAccountSnapshot(this.accountAddress);
    this.applyAccountSnapshotPricing(accountSnapshot);
    this.lastAccountStreamEventAt = Date.now();
    if (this.startingBalanceUsd <= 0) {
      this.startingBalanceUsd = accountSnapshot.accountValueUsd;
      this.peakEquityUsd = accountSnapshot.accountValueUsd;
    }

    const openOrders = await this.gateway.fetchOpenOrders(this.accountAddress);
    this.applyOpenOrdersSnapshot(openOrders);
    this.lastFullReconcileAt = Date.now();
    if (this.openPositions.size === 0 && accountSnapshot.positionsBySymbol.size > 0) {
      throw new Error(
        "The configured account already has open Hyperliquid positions, but the live broker state file does not track them. Flatten the account or restore the state file before enabling live mode.",
      );
    }

    if (this.openPositions.size === 0 && openOrders.length > 0) {
      throw new Error(
        "The configured account already has open Hyperliquid orders, but the live broker state file does not track them. Cancel those orders or restore the state file before enabling live mode.",
      );
    }

    const leverageLogs: string[] = [];
    for (const symbol of this.config.watchlist) {
      const appliedLeverage = await this.gateway.ensureLeverage(
        symbol,
        this.config.live.defaultLeverage,
        this.config.live.marginMode,
      );
      leverageLogs.push(`${symbol}: configured ${this.config.live.marginMode} ${appliedLeverage}x leverage.`);
    }

    this.initialized = true;
    await this.saveState();

    return [
      `live broker initialized for ${wrapOrange(this.accountAddress)} using ${this.config.live.marginMode} margin.`,
      ...leverageLogs,
      this.config.live.dryRun
        ? "dry-run mode is active; exchange writes are disabled."
        : this.config.live.enabled
          ? "live trading is enabled; exchange writes are active."
          : "live trading is disabled by LIVE_TRADING_ENABLED; reads remain active.",
    ];
  }

  async onCycleStart(): Promise<string[]> {
    await this.assertInitialized();
    if (this.usesWebsocketRuntime()) {
      const logs = await this.drainRemoteEvents();
      logs.push(...(await this.runSparseReconcileIfDue("scheduled websocket safety reconciliation")));
      return logs;
    }

    return this.syncRemoteState();
  }

  async prepareSnapshot(): Promise<void> {
    await this.assertInitialized();
    if (!this.accountAddress) {
      return;
    }

    if (this.usesWebsocketRuntime()) {
      await this.drainRemoteEvents();
      await this.runSparseReconcileIfDue("scheduled websocket snapshot reconciliation");
      return;
    }

    const accountSnapshot = await this.gateway.fetchAccountSnapshot(this.accountAddress);
    this.applyAccountSnapshotPricing(accountSnapshot);

    try {
      this.lifetimeFundingUsd = await this.gateway.fetchUserLifetimeFundingUsd(this.accountAddress);
    } catch {
      // Keep last known value on transient API errors.
    }

    try {
      this.portfolioAllTimePnlUsd = await this.gateway.fetchPortfolioAllTimePnlUsd(this.accountAddress);
    } catch {
      // Keep last known value on transient API errors.
    }
  }

  hasOpenPosition(symbol: string, strategyId: string): boolean {
    return this.getOpenPositions(symbol, strategyId).length > 0;
  }

  getOpenPositions(symbol: string, strategyId: string): BrokerPosition[] {
    return [...this.openPositions.values()]
      .filter((position) => position.symbol === symbol && position.strategyId === strategyId)
      .map(clonePosition);
  }

  snapshot(): BrokerSnapshot {
    const unrealizedPnlUsd = this.computeUnrealizedPnlUsd();

    const localEquityUsd = this.startingBalanceUsd + this.realizedPnlUsd + unrealizedPnlUsd;

    return {
      startingBalanceUsd: this.startingBalanceUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      lifetimeFundingUsd: this.lifetimeFundingUsd,
      unrealizedPnlUsd,
      allTimePnlUsd: this.portfolioAllTimePnlUsd,
      equityUsd: this.currentAccountValueUsd ?? localEquityUsd,
      maxDrawdownPct: this.maxDrawdownPct,
      grossProfitUsd: this.grossProfitUsd,
      grossLossUsd: this.grossLossUsd,
      totalFeesUsd: this.totalFeesUsd,
      wins: this.wins,
      losses: this.losses,
      openPositions: [...this.openPositions.values()].map(clonePosition),
      closedPositions: this.closedPositions.map(clonePosition),
      cancelledPositions: this.cancelledPositions.map(clonePosition),
    };
  }

  getAccountAddress(): `0x${string}` | undefined {
    return this.accountAddress;
  }

  enqueueRemoteEvent(event: HyperliquidAccountStreamEvent): void {
    this.remoteEventQueue.push(event);
    this.lastAccountStreamEventAt = event.receivedAt;
    if (event.type !== "subscriptionFailure") {
      this.remoteStreamFailedReason = undefined;
    }

    const waiters = this.remoteEventWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  markRemoteSubscriptionFailed(feed: string, reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.remoteStreamFailedReason = `${feed}: ${message}`;
    this.enqueueRemoteEvent({
      type: "subscriptionFailure",
      receivedAt: Date.now(),
      feed,
      message,
    });
  }

  private applyAccountSnapshotPricing(accountSnapshot: HyperliquidAccountSnapshot): void {
    this.currentAccountValueUsd = accountSnapshot.accountValueUsd;
    this.lastExchangeUnrealizedBySymbol.clear();
    for (const [symbol, pos] of accountSnapshot.positionsBySymbol) {
      this.lastExchangeUnrealizedBySymbol.set(symbol, pos.unrealizedPnlUsd);
    }
  }

  private applyOpenOrdersSnapshot(openOrders: HyperliquidOpenOrder[]): Map<`0x${string}`, HyperliquidOpenOrder> {
    this.openExchangeOrderIds = new Set(openOrders.flatMap((order) => (order.clientOrderId ? [order.clientOrderId] : [])));
    this.openExchangeOrderOids = new Set(openOrders.map((order) => order.orderId));

    const openOrdersByClientOrderId = new Map<`0x${string}`, HyperliquidOpenOrder>();
    for (const order of openOrders) {
      if (order.clientOrderId) {
        openOrdersByClientOrderId.set(order.clientOrderId, order);
      }
    }

    for (const position of this.openPositions.values()) {
      this.hydrateTrackedExchangeOrderIds(position, openOrdersByClientOrderId);
    }

    return openOrdersByClientOrderId;
  }

  /** Clearinghouse uPnL when available; else candle marks (e.g. after a failed sync). */
  private computeUnrealizedPnlUsd(): number {
    const symbolsWithOpen = new Set<string>();
    for (const position of this.openPositions.values()) {
      if (position.status === "open" && position.averageEntryPrice !== undefined) {
        symbolsWithOpen.add(position.symbol);
      }
    }

    if (symbolsWithOpen.size === 0) {
      return 0;
    }

    let total = 0;
    for (const symbol of symbolsWithOpen) {
      const exchangeU = this.lastExchangeUnrealizedBySymbol.get(symbol);
      if (exchangeU !== undefined) {
        total += exchangeU;
        continue;
      }

      for (const position of this.openPositions.values()) {
        if (position.symbol !== symbol || position.status !== "open" || position.averageEntryPrice === undefined) {
          continue;
        }

        const markPrice = this.lastMarks.get(position.symbol);
        if (markPrice) {
          total += calculatePnlUsd(position.side, position.averageEntryPrice, markPrice, position.remainingSizeUnits);
        }
      }
    }

    return total;
  }

  private isOrderOpenOnExchange(order: { clientOrderId?: `0x${string}`; exchangeOrderId?: number }): boolean {
    return (
      (order.clientOrderId !== undefined && this.openExchangeOrderIds.has(order.clientOrderId)) ||
      (order.exchangeOrderId !== undefined && this.openExchangeOrderOids.has(order.exchangeOrderId))
    );
  }

  private hydrateTrackedExchangeOrderIds(
    position: BrokerPosition,
    openOrdersByClientOrderId: ReadonlyMap<`0x${string}`, HyperliquidOpenOrder>,
  ): void {
    const hydrateOrder = (order: { clientOrderId?: `0x${string}`; exchangeOrderId?: number }): void => {
      if (!order.clientOrderId) {
        return;
      }

      const openOrder = openOrdersByClientOrderId.get(order.clientOrderId);
      if (openOrder) {
        order.exchangeOrderId = openOrder.orderId;
      }
    };

    for (const order of position.entryOrders) {
      hydrateOrder(order);
    }

    for (const order of position.exitOrders) {
      hydrateOrder(order);
    }

    if (position.stopOrder) {
      hydrateOrder(position.stopOrder);
    }
  }

  private buildKnownOrdersByClientOrderId(): Map<
    `0x${string}`,
    { position: BrokerPosition; kind: "entry" | "exit" | "stop"; order: TrackedPositionOrder }
  > {
    const knownOrdersByClientOrderId = new Map<
      `0x${string}`,
      { position: BrokerPosition; kind: "entry" | "exit" | "stop"; order: TrackedPositionOrder }
    >();

    for (const position of this.openPositions.values()) {
      for (const order of position.entryOrders) {
        if (order.clientOrderId) {
          knownOrdersByClientOrderId.set(order.clientOrderId, { position, kind: "entry", order });
        }
      }

      for (const order of position.exitOrders) {
        if (order.clientOrderId) {
          knownOrdersByClientOrderId.set(order.clientOrderId, { position, kind: "exit", order });
        }
      }

      if (position.stopOrder?.clientOrderId) {
        knownOrdersByClientOrderId.set(position.stopOrder.clientOrderId, {
          position,
          kind: "stop",
          order: position.stopOrder,
        });
      }
    }

    return knownOrdersByClientOrderId;
  }

  async openPosition(signal: StrategySignal): Promise<string[]> {
    await this.assertInitialized();
    const logs: string[] = [];
    const assetInfo = this.gateway.getAssetInfo(signal.symbol);
    const entryOrders = buildPlannedEntryOrders(signal, this.config.positionSizeUsd, {
      szDecimals: assetInfo.szDecimals,
    });
    const intendedSizeUnits = entryOrders.reduce((sum, order) => sum + order.sizeUnits, 0);
    const intendedNotionalUsd = calculatePlannedEntryNotionalUsd(entryOrders);

    if (!this.config.watchlist.includes(signal.symbol)) {
      return [`${signal.symbol}: skipped live order because it is not present in WATCHLIST.`];
    }

    if (intendedSizeUnits <= POSITION_EPSILON) {
      return [`${signal.symbol}: skipped live order because the resolved size is zero.`];
    }

    if (intendedNotionalUsd > this.config.live.maxNotionalUsd) {
      return [
        `${signal.symbol}: skipped live order because planned notional ${intendedNotionalUsd.toFixed(2)} USD exceeds LIVE_MAX_NOTIONAL_USD ${this.config.live.maxNotionalUsd.toFixed(2)} USD.`,
      ];
    }

    if (this.openPositions.size >= this.config.live.maxOpenPositions) {
      return [
        `${signal.symbol}: skipped live order because LIVE_MAX_OPEN_POSITIONS ${this.config.live.maxOpenPositions} has already been reached.`,
      ];
    }

    if (!this.writesEnabled()) {
      return [
        `${signal.symbol}: dry-run/live-disabled mode would place ${entryOrders.length} entry orders totalling ${intendedNotionalUsd.toFixed(2)} USD notional.`,
      ];
    }

    const remoteEventLogs = await this.drainRemoteEvents();
    logs.push(...remoteEventLogs);
    if (this.remoteStreamFailedReason) {
      return [
        ...logs,
        `${signal.symbol}: skipped live order because Hyperliquid websocket account state is unhealthy (${this.remoteStreamFailedReason}).`,
      ];
    }
    if (this.accountStreamIsStale()) {
      return [
        ...logs,
        `${signal.symbol}: skipped live order because Hyperliquid websocket account state is stale; waiting for stream recovery or sparse reconciliation.`,
      ];
    }

    logs.push(...(await this.flattenOpposingExposure(signal)));

    const exitOrders = signal.exitOrders.map((order) => ({
      label: order.label,
      price: order.price,
      sizeFraction: order.sizeFraction ?? 0,
      sizeUnits: intendedSizeUnits * (order.sizeFraction ?? 0),
      status: "pending" as const,
    }));

    const positionId = `${signal.strategyId}-${signal.symbol}-${signal.generatedAt}-${this.nextPositionSequence++}`;
    const position: BrokerPosition = {
      id: positionId,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      side: signal.side,
      entryReferencePrice: signal.entryReferencePrice,
      signalTime: signal.generatedAt,
      expiryTime: signal.expiryTime,
      stopLoss: signal.stopLoss,
      intendedSizeUnits,
      filledSizeUnits: 0,
      remainingSizeUnits: 0,
      entryOrders,
      exitOrders,
      realizedPnlUsd: 0,
      status: "pending",
      ...(signal.setupKind ? { setupKind: signal.setupKind } : {}),
      ...(signal.entryMode ? { entryMode: signal.entryMode } : {}),
      ...(signal.netPositionBeforeEntry ? { netPositionBeforeEntry: signal.netPositionBeforeEntry } : {}),
      ...(signal.metadata ? { metadata: { ...signal.metadata } } : {}),
    };

    this.openPositions.set(position.id, position);
    await this.gateway.ensureLeverage(signal.symbol, this.config.live.defaultLeverage, this.config.live.marginMode);

    const orderSpecs = position.entryOrders.map((order, index) => {
      const clientOrderId = this.buildClientOrderId(position.id, `entry-${index}`);
      order.clientOrderId = clientOrderId;

      return {
        symbol: signal.symbol,
        side: signal.side,
        price: order.price,
        sizeUnits: order.sizeUnits,
        reduceOnly: false,
        tif: "Gtc",
        clientOrderId,
      } satisfies HyperliquidPlaceOrderSpec;
    });

    const results = await this.gateway.placeOrders(orderSpecs);
    for (const [index, result] of results.entries()) {
      const order = position.entryOrders[index];
      if (!order) {
        continue;
      }

      if (result.orderId !== undefined) {
        order.exchangeOrderId = result.orderId;
      }
      logs.push(
        `${position.symbol}: submitted ${order.label} ${position.side} order for ${(order.sizeUnits * order.price).toFixed(2)} USD notional (${result.status}).`,
      );
    }

    await this.saveState();
    if (this.usesWebsocketRuntime()) {
      const needsConfirmation = results.some((result) => result.status === "filled" || result.status === "waitingForFill");
      if (needsConfirmation) {
        const eventArrived = await this.waitForRemoteEvent(this.config.websocket.postWriteEventWaitMs);
        logs.push(...(await this.drainRemoteEvents()));
        if (!eventArrived) {
          logs.push(`${position.symbol}: websocket fill confirmation did not arrive after entry placement; falling back to one REST reconciliation.`);
          logs.push(...(await this.syncRemoteState()));
        }
      } else {
        logs.push(...(await this.drainRemoteEvents()));
      }
      logs.push(...(await this.ensureProtectiveOrders()));
    } else {
      logs.push(...(await this.syncRemoteState()));
      logs.push(...(await this.ensureProtectiveOrders()));
    }
    await this.saveState();

    return logs;
  }

  async cancelPositionById(positionId: string, closedAt: number, reason: string, note?: string): Promise<string[]> {
    await this.assertInitialized();
    const position = this.openPositions.get(positionId);
    if (!position) {
      return [];
    }

    if (!this.writesEnabled()) {
      return [`${position.symbol}: dry-run/live-disabled mode would cancel ${position.id}.`];
    }

    const cancelResult = await this.cancelExchangeOrdersForPosition(position);
    const logs = [...cancelResult.logs];
    if (position.status === "open" && position.remainingSizeUnits > POSITION_EPSILON) {
      const referencePrice = this.lastMarks.get(position.symbol) ?? position.entryReferencePrice;
      const closeClientOrderId = this.buildClientOrderId(position.id, `manual-close-${closedAt}`);
      await this.gateway.placeOrders([
        {
          symbol: position.symbol,
          side: oppositeTradeSide(position.side),
          price: this.applySlippage(oppositeTradeSide(position.side), referencePrice),
          sizeUnits: position.remainingSizeUnits,
          reduceOnly: true,
          tif: "FrontendMarket",
          clientOrderId: closeClientOrderId,
        },
      ]);
      logs.push(`${position.symbol}: submitted reduce-only market close for ${position.id}.`);
      if (this.usesWebsocketRuntime()) {
        const eventArrived = await this.waitForRemoteEvent(this.config.websocket.postWriteEventWaitMs);
        logs.push(...(await this.drainRemoteEvents()));
        if (!eventArrived) {
          logs.push(...(await this.syncRemoteState()));
        }
      } else {
        await this.syncRemoteState();
      }
    } else {
      logs.push(...this.cancelPositionLocally(position, closedAt, reason, note));
    }

    await this.saveState();
    return logs;
  }

  async processCandle(symbol: string, candle: Candle): Promise<string[]> {
    this.lastMarks.set(symbol, candle.close);
    return [];
  }

  async recordEquity(markPrices: Record<string, number>): Promise<void> {
    for (const [symbol, price] of Object.entries(markPrices)) {
      this.lastMarks.set(symbol, price);
    }

    const snapshot = this.snapshot();
    if (snapshot.equityUsd > this.peakEquityUsd) {
      this.peakEquityUsd = snapshot.equityUsd;
    }

    const drawdownPct =
      this.peakEquityUsd <= 0 ? 0 : (this.peakEquityUsd - snapshot.equityUsd) / this.peakEquityUsd;
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, drawdownPct);
    await this.saveState();
  }

  private async drainRemoteEvents(): Promise<string[]> {
    const logs: string[] = [];
    if (this.remoteEventQueue.length === 0) {
      return logs;
    }

    const events = this.remoteEventQueue.splice(0).sort((left, right) => left.receivedAt - right.receivedAt);
    for (const event of events) {
      if (event.type === "subscriptionFailure") {
        this.remoteStreamFailedReason = `${event.feed}: ${event.message}`;
        logs.push(`Hyperliquid websocket subscription ${event.feed} failed: ${event.message}. Live entries are paused until reconciliation succeeds.`);
        continue;
      }

      this.lastAccountStreamEventAt = event.receivedAt;

      if (event.type === "clearinghouseState") {
        this.applyAccountSnapshotPricing(event.snapshot);
        continue;
      }

      if (event.type === "openOrders") {
        this.applyOpenOrdersSnapshot(event.orders);
        logs.push(...this.reconcileTrackedPositionsFromOrderState(event.receivedAt));
        continue;
      }

      if (event.type === "orderUpdates") {
        logs.push(...this.applyOrderUpdates(event.updates, event.receivedAt));
        continue;
      }

      if (event.type === "fills") {
        logs.push(...this.applyRemoteFills(event.fills, event.receivedAt));
        continue;
      }

      if (event.type === "fundings") {
        if (event.isSnapshot) {
          this.lifetimeFundingUsd = event.fundings.reduce((sum, funding) => sum + funding.usdc, 0);
        } else {
          this.lifetimeFundingUsd += event.fundings.reduce((sum, funding) => sum + funding.usdc, 0);
        }
      }
    }

    logs.push(...(await this.ensureProtectiveOrders()));
    this.trimProcessedTradeIds();
    await this.recordEquity(Object.fromEntries(this.lastMarks.entries()));
    await this.saveState();
    return logs;
  }

  private applyRemoteFills(fills: HyperliquidFill[], timestamp: number): string[] {
    const logs: string[] = [];
    const knownOrdersByClientOrderId = this.buildKnownOrdersByClientOrderId();
    const unprocessedFills = fills
      .filter(
        (fill) =>
          fill.clientOrderId &&
          knownOrdersByClientOrderId.has(fill.clientOrderId) &&
          !this.processedTradeIds.has(fill.tradeId),
      )
      .sort((left, right) => left.time - right.time || left.tradeId - right.tradeId);

    for (const fill of unprocessedFills) {
      const route = knownOrdersByClientOrderId.get(fill.clientOrderId!);
      if (!route) {
        continue;
      }

      route.order.exchangeOrderId = fill.orderId;
      if (route.kind === "entry") {
        this.applyEntryFill(route.position, route.order as PositionEntryOrder, fill);
        logs.push(`${fill.symbol}: websocket fill applied to ${route.position.id} entry order.`);
      } else {
        this.applyExitFill(
          route.position,
          route.order as PositionExitOrder | PositionStopOrder,
          fill,
          route.kind === "stop" ? "stop loss hit" : "exit order filled",
        );
        logs.push(`${fill.symbol}: websocket fill applied to ${route.position.id} ${route.kind} order.`);
      }

      this.processedTradeIds.add(fill.tradeId);
    }

    logs.push(...this.reconcileTrackedPositionsFromOrderState(timestamp));
    return logs;
  }

  private applyOrderUpdates(updates: HyperliquidOrderUpdate[], timestamp: number): string[] {
    for (const update of updates) {
      const clientOrderId = update.order.clientOrderId;
      if (update.status === "open" || update.status === "triggered") {
        if (clientOrderId) {
          this.openExchangeOrderIds.add(clientOrderId);
        }
        this.openExchangeOrderOids.add(update.order.orderId);
        continue;
      }

      if (clientOrderId) {
        this.openExchangeOrderIds.delete(clientOrderId);
      }
      this.openExchangeOrderOids.delete(update.order.orderId);
    }

    return this.reconcileTrackedPositionsFromOrderState(timestamp);
  }

  private reconcileTrackedPositionsFromOrderState(timestamp: number): string[] {
    const logs: string[] = [];
    for (const position of [...this.openPositions.values()]) {
      this.reconcilePositionOrderStatuses(position);

      if (position.status === "pending" && position.filledSizeUnits <= POSITION_EPSILON) {
        const hasOpenEntryOrders = position.entryOrders.some((order) => this.isOrderOpenOnExchange(order));
        if (!hasOpenEntryOrders) {
          logs.push(...this.cancelPositionLocally(position, timestamp, "entry ladder expired or was cancelled by the exchange"));
        }
      }

      if (position.status === "open" && position.remainingSizeUnits <= POSITION_EPSILON) {
        logs.push(...this.finishPosition(position, timestamp, position.closeReason ?? "position fully exited"));
      }
    }

    return logs;
  }

  private async runSparseReconcileIfDue(reason: string): Promise<string[]> {
    if (!this.usesWebsocketRuntime() || this.config.websocket.safetyReconcileMs <= 0) {
      return [];
    }

    const now = Date.now();
    if (this.lastFullReconcileAt > 0 && now - this.lastFullReconcileAt < this.config.websocket.safetyReconcileMs) {
      return [];
    }

    const logs = await this.syncRemoteState();
    logs.unshift(`Hyperliquid ${reason}.`);
    if (logs.length === 1) {
      logs.push("Hyperliquid sparse reconciliation completed with no local changes.");
    }
    const reconcileFailed = logs.some((line) => line.startsWith("Hyperliquid sync failed:"));
    if (!reconcileFailed) {
      this.remoteStreamFailedReason = undefined;
      this.lastAccountStreamEventAt = now;
    }
    return logs;
  }

  private usesWebsocketRuntime(): boolean {
    return this.config.runtimeMode === "websocket";
  }

  private accountStreamIsStale(now = Date.now()): boolean {
    return this.usesWebsocketRuntime() && now - this.lastAccountStreamEventAt > this.config.websocket.accountDataStaleMs;
  }

  private waitForRemoteEvent(timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = this.remoteEventWaiters.indexOf(resolveTrue);
        if (index >= 0) {
          this.remoteEventWaiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);

      const resolveTrue = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };

      this.remoteEventWaiters.push(resolveTrue);
    });
  }

  private async syncRemoteState(): Promise<string[]> {
    if (!this.accountAddress) {
      return [];
    }

    const logs: string[] = [];
    const syncStartedAt = Date.now();
    const fillStartTime =
      this.lastSyncTime > 0
        ? Math.max(0, this.lastSyncTime - 60_000)
        : Math.max(0, this.getEarliestTrackedSignalTime() - 60_000);

    try {
      const [accountSnapshot, openOrders, fills] = await Promise.all([
        this.gateway.fetchAccountSnapshot(this.accountAddress),
        this.gateway.fetchOpenOrders(this.accountAddress),
        this.gateway.fetchFillsSince(this.accountAddress, fillStartTime, syncStartedAt),
      ]);

      this.applyAccountSnapshotPricing(accountSnapshot);
      this.applyOpenOrdersSnapshot(openOrders);
      const knownOrdersByClientOrderId = this.buildKnownOrdersByClientOrderId();

      const unprocessedFills = fills
        .filter(
          (fill) =>
            fill.clientOrderId &&
            knownOrdersByClientOrderId.has(fill.clientOrderId) &&
            !this.processedTradeIds.has(fill.tradeId),
        )
        .sort((left, right) => left.time - right.time || left.tradeId - right.tradeId);

      for (const fill of unprocessedFills) {
        const route = knownOrdersByClientOrderId.get(fill.clientOrderId!);
        if (!route) {
          continue;
        }

        if (route.kind === "entry") {
          this.applyEntryFill(route.position, route.order as PositionEntryOrder, fill);
        } else {
          this.applyExitFill(
            route.position,
            route.order as PositionExitOrder | PositionStopOrder,
            fill,
            route.kind === "stop" ? "stop loss hit" : "exit order filled",
          );
        }

        this.processedTradeIds.add(fill.tradeId);
      }

      for (const position of [...this.openPositions.values()]) {
        this.reconcilePositionOrderStatuses(position);

        if (position.status === "pending" && position.filledSizeUnits <= POSITION_EPSILON) {
          const hasOpenEntryOrders = position.entryOrders.some((order) => this.isOrderOpenOnExchange(order));
          if (!hasOpenEntryOrders) {
            logs.push(
              ...this.cancelPositionLocally(position, syncStartedAt, "entry ladder expired or was cancelled by the exchange"),
            );
          }
        }

        if (position.status === "open" && position.remainingSizeUnits <= POSITION_EPSILON) {
          logs.push(...this.finishPosition(position, syncStartedAt, position.closeReason ?? "position fully exited"));
        }
      }

      this.lastSyncTime = syncStartedAt;
      this.lastFullReconcileAt = syncStartedAt;
      this.lastAccountStreamEventAt = syncStartedAt;
      this.remoteStreamFailedReason = undefined;
      this.trimProcessedTradeIds();
      logs.push(...(await this.ensureProtectiveOrders()));
      await this.recordEquity(Object.fromEntries(this.lastMarks.entries()));
      await this.saveState();

      return logs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        `Hyperliquid sync failed: ${message}. Using cached broker state for this cycle; will retry on the next tick.`,
      ];
    }
  }

  private applyEntryFill(position: BrokerPosition, order: PositionEntryOrder, fill: HyperliquidFill): void {
    const priorOrderFilledSize = order.filledSizeUnits ?? 0;
    const remainingOrderSize = Math.max(0, order.sizeUnits - priorOrderFilledSize);
    const deltaSizeUnits = Math.min(fill.sizeUnits, remainingOrderSize);
    if (deltaSizeUnits <= POSITION_EPSILON) {
      return;
    }

    order.exchangeOrderId = fill.orderId;
    order.filledSizeUnits = priorOrderFilledSize + deltaSizeUnits;
    order.averageFillPrice = weightedAverage(priorOrderFilledSize, order.averageFillPrice, deltaSizeUnits, fill.price);
    order.feePaidUsd = (order.feePaidUsd ?? 0) + fill.feeUsd;
    order.filledAt = fill.time;
    order.status = order.filledSizeUnits >= order.sizeUnits - POSITION_EPSILON ? "filled" : "pending";

    const priorPositionFilledSize = position.filledSizeUnits;
    position.averageEntryPrice = weightedAverage(
      priorPositionFilledSize,
      position.averageEntryPrice,
      deltaSizeUnits,
      fill.price,
    );
    position.filledSizeUnits += deltaSizeUnits;
    position.remainingSizeUnits += deltaSizeUnits;
    position.status = "open";
    position.realizedPnlUsd -= fill.feeUsd;
    this.realizedPnlUsd -= fill.feeUsd;
    this.totalFeesUsd += fill.feeUsd;
  }

  private applyExitFill(
    position: BrokerPosition,
    order: PositionExitOrder | PositionStopOrder,
    fill: HyperliquidFill,
    closeReason: string,
  ): void {
    if (position.averageEntryPrice === undefined) {
      return;
    }

    const priorOrderFilledSize = order.filledSizeUnits ?? 0;
    const remainingOrderSize = Math.max(0, order.sizeUnits - priorOrderFilledSize);
    const deltaSizeUnits = Math.min(fill.sizeUnits, remainingOrderSize, position.remainingSizeUnits);
    if (deltaSizeUnits <= POSITION_EPSILON) {
      return;
    }

    order.exchangeOrderId = fill.orderId;
    order.filledSizeUnits = priorOrderFilledSize + deltaSizeUnits;
    order.averageFillPrice = weightedAverage(priorOrderFilledSize, order.averageFillPrice, deltaSizeUnits, fill.price);
    order.feePaidUsd = (order.feePaidUsd ?? 0) + fill.feeUsd;
    order.status = order.filledSizeUnits >= order.sizeUnits - POSITION_EPSILON ? "filled" : "pending";
    if ("hitAt" in order) {
      order.hitAt = fill.time;
    } else {
      (order as PositionStopOrder).filledAt = fill.time;
    }

    position.remainingSizeUnits -= deltaSizeUnits;
    const realizedPnlUsd =
      calculatePnlUsd(position.side, position.averageEntryPrice, fill.price, deltaSizeUnits) - fill.feeUsd;
    position.realizedPnlUsd += realizedPnlUsd;
    this.realizedPnlUsd += realizedPnlUsd;
    this.totalFeesUsd += fill.feeUsd;

    if (position.remainingSizeUnits <= POSITION_EPSILON) {
      position.closeReason = closeReason;
    }
  }

  private reconcilePositionOrderStatuses(position: BrokerPosition): void {
    for (const order of position.entryOrders) {
      const isOpenOnExchange = this.isOrderOpenOnExchange(order);
      if (isOpenOnExchange) {
        order.status = "pending";
        continue;
      }

      if ((order.filledSizeUnits ?? 0) >= order.sizeUnits - POSITION_EPSILON) {
        order.status = "filled";
        continue;
      }

      if ((order.filledSizeUnits ?? 0) > POSITION_EPSILON) {
        order.status = "filled";
        continue;
      }

      if (order.status === "pending") {
        order.status = "cancelled";
      }
    }

    for (const order of position.exitOrders) {
      const isOpenOnExchange = this.isOrderOpenOnExchange(order);
      if (isOpenOnExchange) {
        order.status = "pending";
        continue;
      }

      if ((order.filledSizeUnits ?? 0) >= order.sizeUnits - POSITION_EPSILON) {
        order.status = "filled";
        continue;
      }

      if ((order.filledSizeUnits ?? 0) > POSITION_EPSILON) {
        order.status = "filled";
        continue;
      }

      if (order.status === "pending") {
        order.status = "cancelled";
      }
    }

    if (position.stopOrder) {
      const isOpenOnExchange = this.isOrderOpenOnExchange(position.stopOrder);
      if (isOpenOnExchange) {
        position.stopOrder.status = "pending";
      } else if ((position.stopOrder.filledSizeUnits ?? 0) >= position.stopOrder.sizeUnits - POSITION_EPSILON) {
        position.stopOrder.status = "filled";
      } else if ((position.stopOrder.filledSizeUnits ?? 0) <= POSITION_EPSILON) {
        position.stopOrder.status = "cancelled";
      }
    }
  }

  private async ensureProtectiveOrders(): Promise<string[]> {
    const logs: string[] = [];
    if (!this.writesEnabled()) {
      return logs;
    }

    for (const position of this.openPositions.values()) {
      if (position.status !== "open" || position.remainingSizeUnits <= POSITION_EPSILON) {
        continue;
      }

      logs.push(...(await this.ensureProtectiveOrdersForPosition(position)));
    }

    return logs;
  }

  private async ensureProtectiveOrdersForPosition(position: BrokerPosition): Promise<string[]> {
    const logs: string[] = [];
    const protectivePlacements: Array<{
      order: PositionExitOrder | PositionStopOrder;
      spec: HyperliquidPlaceOrderSpec;
    }> = [];
    const assetInfo = this.gateway.getAssetInfo(position.symbol);

    const desiredStop = {
      price: position.stopLoss,
      sizeUnits: position.remainingSizeUnits,
    };

    if (!position.stopOrder) {
      position.stopOrder = {
        price: desiredStop.price,
        sizeUnits: desiredStop.sizeUnits,
        status: "cancelled",
      };
    }

    const stopNeedsReplace =
      !isSameNumber(position.stopOrder.price, desiredStop.price) ||
      !isSameNumber(position.stopOrder.sizeUnits, desiredStop.sizeUnits) ||
      !position.stopOrder.clientOrderId ||
      !this.isOrderOpenOnExchange(position.stopOrder);

    if (stopNeedsReplace) {
      const currentStopOrder = position.stopOrder;
      const hasExistingStopHandle =
        currentStopOrder.clientOrderId !== undefined || currentStopOrder.exchangeOrderId !== undefined;
      let canReplaceStop = true;

      if (hasExistingStopHandle) {
        const cancelResult = await this.cancelExchangeOrdersForPosition(position, { stopOnly: true });
        logs.push(...cancelResult.logs);
        const stopCancelFailed = cancelResult.trackedResults.some(
          (tracked) => tracked.order === currentStopOrder && tracked.result.status === "error",
        );
        if (stopCancelFailed) {
          logs.push(
            `${position.symbol}: skipped stop-loss replacement for ${position.id} because the previous stop order could not be cancelled.`,
          );
          canReplaceStop = false;
        }
      }

      if (canReplaceStop) {
        const clientOrderId = this.buildProtectiveClientOrderId(
          position.id,
          `stop-${desiredStop.sizeUnits.toFixed(8)}-${desiredStop.price.toFixed(8)}`,
        );
        position.stopOrder = {
          price: desiredStop.price,
          sizeUnits: desiredStop.sizeUnits,
          status: "pending",
          clientOrderId,
        };
        protectivePlacements.push({
          order: position.stopOrder,
          spec: {
            symbol: position.symbol,
            side: oppositeTradeSide(position.side),
            price: this.applySlippage(oppositeTradeSide(position.side), position.stopLoss),
            sizeUnits: desiredStop.sizeUnits,
            reduceOnly: true,
            clientOrderId,
            trigger: {
              isMarket: true,
              triggerPx: position.stopLoss,
              tpsl: "sl",
            },
          },
        });
      }
    }

    const desiredExitSizeUnits = allocatePrioritizedExitOrderTargets({
      totalSizeUnits: position.filledSizeUnits,
      exitPrices: position.exitOrders.map((order) => order.price),
      sizeDecimals: assetInfo.szDecimals,
      minOrderNotionalUsd: MIN_TAKE_PROFIT_ORDER_NOTIONAL_USD,
    });

    for (const [index, order] of position.exitOrders.entries()) {
      const desiredTotalSizeUnits = desiredExitSizeUnits[index] ?? 0;
      const desiredOpenSizeUnits = Math.max(0, desiredTotalSizeUnits - (order.filledSizeUnits ?? 0));
      const currentOutstandingSizeUnits = Math.max(0, order.sizeUnits - (order.filledSizeUnits ?? 0));
      const orderIsOpen = this.isOrderOpenOnExchange(order);

      if (desiredOpenSizeUnits <= POSITION_EPSILON) {
        if (orderIsOpen) {
          const cancelResult = await this.cancelExchangeOrdersForPosition(position, { exitOrderIndexes: [index] });
          logs.push(...cancelResult.logs);
          const cancelFailed = cancelResult.trackedResults.some(
            (tracked) => tracked.order === order && tracked.result.status === "error",
          );
          if (cancelFailed) {
            logs.push(
              `${position.symbol}: kept ${order.label} for ${position.id} because the exchange did not confirm the cancel.`,
            );
            continue;
          }
        }

        order.sizeUnits = desiredTotalSizeUnits;
        order.status = resolveCancelledOrderStatus(order);
        continue;
      }

      const needsReplace =
        !isSameNumber(order.sizeUnits, desiredTotalSizeUnits) ||
        !isSameNumber(currentOutstandingSizeUnits, desiredOpenSizeUnits) ||
        !order.clientOrderId ||
        !orderIsOpen;

      if (!needsReplace) {
        continue;
      }

      const hasExistingOrderHandle = order.clientOrderId !== undefined || order.exchangeOrderId !== undefined;
      if (hasExistingOrderHandle) {
        const cancelResult = await this.cancelExchangeOrdersForPosition(position, { exitOrderIndexes: [index] });
        logs.push(...cancelResult.logs);
        const cancelFailed = cancelResult.trackedResults.some(
          (tracked) => tracked.order === order && tracked.result.status === "error",
        );
        if (cancelFailed) {
          logs.push(
            `${position.symbol}: skipped take-profit replacement for ${position.id} (${order.label}) because the previous order could not be cancelled.`,
          );
          continue;
        }
      }

      order.sizeUnits = desiredTotalSizeUnits;
      order.status = "pending";
      delete order.exchangeOrderId;
      const clientOrderId = this.buildProtectiveClientOrderId(
        position.id,
        `tp-${index}-${desiredOpenSizeUnits.toFixed(8)}-${order.price.toFixed(8)}`,
      );
      order.clientOrderId = clientOrderId;
      protectivePlacements.push({
        order,
        spec: {
          symbol: position.symbol,
          side: oppositeTradeSide(position.side),
          price: order.price,
          sizeUnits: desiredOpenSizeUnits,
          reduceOnly: true,
          tif: "Gtc",
          clientOrderId,
        },
      });
    }

    if (protectivePlacements.length === 0) {
      return logs;
    }

    const results = await this.gateway.placeOrders(protectivePlacements.map((placement) => placement.spec));
    for (const [index, result] of results.entries()) {
      const placement = protectivePlacements[index];
      if (!placement) {
        continue;
      }

      if (result.orderId !== undefined) {
        placement.order.exchangeOrderId = result.orderId;
      }
      logs.push(`${position.symbol}: submitted protective order ${result.clientOrderId ?? "unknown"} (${result.status}).`);
    }

    return logs;
  }

  private async flattenOpposingExposure(signal: StrategySignal): Promise<string[]> {
    const logs: string[] = [];
    const oppositePositions = [...this.openPositions.values()].filter(
      (position) =>
        position.symbol === signal.symbol &&
        position.strategyId === signal.strategyId &&
        position.side !== signal.side &&
        position.status !== "closed" &&
        position.status !== "cancelled",
    );

    if (oppositePositions.length === 0) {
      return logs;
    }

    for (const position of oppositePositions) {
      const cancelResult = await this.cancelExchangeOrdersForPosition(position);
      logs.push(...cancelResult.logs);

      if (position.status === "pending" || position.remainingSizeUnits <= POSITION_EPSILON) {
        logs.push(...this.cancelPositionLocally(position, signal.generatedAt, `cancelled before ${signal.side} flip entry`));
        continue;
      }

      const referencePrice = this.lastMarks.get(position.symbol) ?? signal.entryReferencePrice;
      const clientOrderId = this.buildClientOrderId(position.id, `flip-flatten-${signal.generatedAt}`);
      await this.gateway.placeOrders([
        {
          symbol: position.symbol,
          side: oppositeTradeSide(position.side),
          price: this.applySlippage(oppositeTradeSide(position.side), referencePrice),
          sizeUnits: position.remainingSizeUnits,
          reduceOnly: true,
          tif: "FrontendMarket",
          clientOrderId,
        },
      ]);
      logs.push(
        `${position.symbol}: flattened ${position.side} exposure of ${position.remainingSizeUnits.toFixed(6)} units before opening the ${signal.side} flip.`,
      );
    }

    if (this.usesWebsocketRuntime()) {
      const eventArrived = await this.waitForRemoteEvent(this.config.websocket.postWriteEventWaitMs);
      logs.push(...(await this.drainRemoteEvents()));
      if (!eventArrived) {
        logs.push(...(await this.syncRemoteState()));
      }
    } else {
      logs.push(...(await this.syncRemoteState()));
    }
    return logs;
  }

  private async cancelExchangeOrdersForPosition(
    position: BrokerPosition,
    options: { stopOnly?: boolean; exitOrderIndexes?: number[] } = {},
  ): Promise<CancelExchangeOrdersResult> {
    if (!this.writesEnabled()) {
      return { logs: [], trackedResults: [] };
    }

    const trackedRequests: Array<{
      request: HyperliquidCancelOrderRequest;
      order: TrackedPositionOrder;
    }> = [];
    const logs: string[] = [];
    const queueCancel = (
      order: TrackedPositionOrder,
      options: {
        allowWithoutOpenExchangeMatch?: boolean;
      } = {},
    ): void => {
      const hasTrackedHandle = order.clientOrderId !== undefined || order.exchangeOrderId !== undefined;
      if (!hasTrackedHandle) {
        return;
      }

      if (!options.allowWithoutOpenExchangeMatch && !this.isOrderOpenOnExchange(order)) {
        return;
      }

      if (trackedRequests.some((tracked) => tracked.order === order)) {
        return;
      }

      trackedRequests.push({
        request: {
          symbol: position.symbol,
          ...(order.exchangeOrderId !== undefined ? { orderId: order.exchangeOrderId } : {}),
          ...(order.clientOrderId !== undefined ? { clientOrderId: order.clientOrderId } : {}),
        },
        order,
      });
    };

    if (!options.stopOnly && options.exitOrderIndexes === undefined) {
      for (const order of position.entryOrders) {
        queueCancel(order);
      }
    }

    const exitOrders = options.stopOnly
      ? []
      : options.exitOrderIndexes === undefined
        ? position.exitOrders.map((order, index) => ({ order, index }))
        : options.exitOrderIndexes.map((index) => ({ order: position.exitOrders[index]!, index }));
    for (const { order } of exitOrders) {
      if (!order) {
        continue;
      }

      queueCancel(order);
    }

    // Always try cancel-by-cloid when we have a stored id. Relying on `openExchangeOrderIds` alone
    // misses live trigger orders if the info API omits `cloid` on some rows — then we would place a
    // replacement SL without cancelling the old one (duplicate stops on partial ladder fills).
    if (position.stopOrder && (options.exitOrderIndexes === undefined || options.stopOnly)) {
      queueCancel(position.stopOrder, { allowWithoutOpenExchangeMatch: true });
    }

    if (trackedRequests.length === 0) {
      return { logs, trackedResults: [] };
    }

    try {
      const cancelResults = await this.gateway.cancelOrders(trackedRequests.map((tracked) => tracked.request));
      const trackedResults = trackedRequests.map((tracked, index) => ({
        ...tracked,
        result: cancelResults[index]!,
      }));

      let successCount = 0;
      for (const tracked of trackedResults) {
        if (tracked.result.status === "success") {
          successCount += 1;
          if (tracked.request.clientOrderId) {
            this.openExchangeOrderIds.delete(tracked.request.clientOrderId);
          }
          if (tracked.request.orderId !== undefined) {
            this.openExchangeOrderOids.delete(tracked.request.orderId);
          }
          tracked.order.status = resolveCancelledOrderStatus(tracked.order);
          continue;
        }

        logs.push(
          `${position.symbol}: failed to cancel ${this.describeExchangeOrderHandle(tracked.request)} for ${position.id}: ${tracked.result.error ?? "unknown exchange error"}.`,
        );
      }

      if (successCount > 0) {
        logs.push(`${position.symbol}: cancelled ${successCount} exchange order(s) for ${position.id}.`);
      }

      return { logs, trackedResults };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`${position.symbol}: failed to cancel one or more exchange orders for ${position.id}: ${message}.`);
      return {
        logs,
        trackedResults: trackedRequests.map((tracked) => ({
          ...tracked,
          result: {
            ...tracked.request,
            status: "error",
            error: message,
          },
        })),
      };
    }
  }

  private finishPosition(position: BrokerPosition, closedAt: number, closeReason: string): string[] {
    position.status = "closed";
    position.closeReason = closeReason;
    position.closedAt = closedAt;

    this.openPositions.delete(position.id);
    this.closedPositions.push(clonePosition(position));
    this.updateWinLossCounters(position.realizedPnlUsd);

    return [
      `${position.symbol}: live position ${position.id} closed via ${closeReason}. Realized PnL ${position.realizedPnlUsd.toFixed(2)} USD.`,
    ];
  }

  private cancelPositionLocally(position: BrokerPosition, closedAt: number, reason: string, note?: string): string[] {
    position.status = "cancelled";
    position.closeReason = reason;
    position.closedAt = closedAt;

    for (const order of position.entryOrders) {
      if (order.status === "pending") {
        order.status = "cancelled";
      }
    }

    for (const order of position.exitOrders) {
      if (order.status === "pending") {
        order.status = "cancelled";
      }
    }

    if (position.stopOrder?.status === "pending") {
      position.stopOrder.status = "cancelled";
    }

    this.openPositions.delete(position.id);
    this.cancelledPositions.push(clonePosition(position));
    return [note ? `${position.symbol}: ${reason}. ${note}` : `${position.symbol}: ${reason}.`];
  }

  private updateWinLossCounters(pnlUsd: number): void {
    if (pnlUsd > 0) {
      this.wins += 1;
      this.grossProfitUsd += pnlUsd;
      return;
    }

    if (pnlUsd < 0) {
      this.losses += 1;
      this.grossLossUsd += Math.abs(pnlUsd);
    }
  }

  private writesEnabled(): boolean {
    return this.config.live.enabled && !this.config.live.dryRun;
  }

  private applySlippage(side: TradeSide, price: number): number {
    const slippageRate = this.config.live.slippageBps / 10_000;
    if (slippageRate <= 0) {
      return price;
    }

    return isOrderSideBuy(side) ? price * (1 + slippageRate) : price * (1 - slippageRate);
  }

  private buildClientOrderId(positionId: string, suffix: string): `0x${string}` {
    return toClientOrderId(`${positionId}:${suffix}`);
  }

  private buildProtectiveClientOrderId(positionId: string, suffix: string): `0x${string}` {
    return toClientOrderId(`${positionId}:${suffix}:${Date.now()}:${this.nextProtectiveOrderSequence++}`);
  }

  private describeExchangeOrderHandle(request: HyperliquidCancelOrderRequest): string {
    if (request.orderId !== undefined && request.clientOrderId !== undefined) {
      return `order oid=${request.orderId} cloid=${request.clientOrderId}`;
    }

    if (request.orderId !== undefined) {
      return `order oid=${request.orderId}`;
    }

    return `order cloid=${request.clientOrderId ?? "unknown"}`;
  }

  private getEarliestTrackedSignalTime(): number {
    const earliest = [...this.openPositions.values()].reduce(
      (min, position) => Math.min(min, position.signalTime),
      Number.POSITIVE_INFINITY,
    );

    return Number.isFinite(earliest) ? earliest : Date.now();
  }

  private trimProcessedTradeIds(): void {
    if (this.processedTradeIds.size <= PROCESSED_TRADE_ID_LIMIT) {
      return;
    }

    const retained = [...this.processedTradeIds].slice(-PROCESSED_TRADE_ID_LIMIT);
    this.processedTradeIds.clear();
    for (const tradeId of retained) {
      this.processedTradeIds.add(tradeId);
    }
  }

  private async assertInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async loadState(): Promise<void> {
    const statePath = resolveStatePath(this.config.live.stateFile);

    try {
      const rawFile = await readFile(statePath, "utf8");
      const state = JSON.parse(rawFile) as LiveBrokerStateFile;
      this.startingBalanceUsd = state.startingBalanceUsd ?? 0;
      this.realizedPnlUsd = state.realizedPnlUsd ?? 0;
      this.grossProfitUsd = state.grossProfitUsd ?? 0;
      this.grossLossUsd = state.grossLossUsd ?? 0;
      this.totalFeesUsd = state.totalFeesUsd ?? 0;
      this.wins = state.wins ?? 0;
      this.losses = state.losses ?? 0;
      this.peakEquityUsd = state.peakEquityUsd ?? this.startingBalanceUsd;
      this.maxDrawdownPct = state.maxDrawdownPct ?? 0;
      this.nextPositionSequence = state.nextPositionSequence ?? 1;
      this.lastSyncTime = state.lastSyncTime ?? 0;

      for (const [symbol, price] of Object.entries(state.lastMarks ?? {})) {
        this.lastMarks.set(symbol, price);
      }

      for (const tradeId of state.processedTradeIds ?? []) {
        this.processedTradeIds.add(tradeId);
      }

      for (const position of state.openPositions ?? []) {
        this.openPositions.set(position.id, clonePosition(position));
      }

      for (const position of state.closedPositions ?? []) {
        this.closedPositions.push(clonePosition(position));
      }

      for (const position of state.cancelledPositions ?? []) {
        this.cancelledPositions.push(clonePosition(position));
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private async saveState(): Promise<void> {
    const statePath = resolveStatePath(this.config.live.stateFile);
    await mkdir(path.dirname(statePath), { recursive: true });
    const payload: LiveBrokerStateFile = {
      startingBalanceUsd: this.startingBalanceUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      grossProfitUsd: this.grossProfitUsd,
      grossLossUsd: this.grossLossUsd,
      totalFeesUsd: this.totalFeesUsd,
      wins: this.wins,
      losses: this.losses,
      peakEquityUsd: this.peakEquityUsd,
      maxDrawdownPct: this.maxDrawdownPct,
      nextPositionSequence: this.nextPositionSequence,
      lastSyncTime: this.lastSyncTime,
      processedTradeIds: [...this.processedTradeIds],
      lastMarks: Object.fromEntries(this.lastMarks.entries()),
      openPositions: [...this.openPositions.values()].map(clonePosition),
      closedPositions: this.closedPositions.map(clonePosition),
      cancelledPositions: this.cancelledPositions.map(clonePosition),
    };

    await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
