import type {
  Candle,
  BrokerPosition,
  BrokerSnapshot,
  PositionEntryOrder,
  PositionExitOrder,
  StrategySignal,
  TradeSide,
} from "../types.js";
import type { Broker } from "./broker.js";

const POSITION_EPSILON = 1e-9;

function calculatePnlUsd(side: TradeSide, entryPrice: number, exitPrice: number, sizeUnits: number): number {
  if (side === "long") {
    return (exitPrice - entryPrice) * sizeUnits;
  }

  return (entryPrice - exitPrice) * sizeUnits;
}

function orderIsMarketable(side: TradeSide, orderPrice: number, referencePrice: number): boolean {
  if (side === "long") {
    return orderPrice >= referencePrice;
  }

  return orderPrice <= referencePrice;
}

function orderWasTouched(orderPrice: number, candle: Candle): boolean {
  return candle.low <= orderPrice && candle.high >= orderPrice;
}

function stopDistance(side: TradeSide, entryPrice: number, stopLoss: number): number {
  if (side === "long") {
    return entryPrice - stopLoss;
  }

  return stopLoss - entryPrice;
}

function clonePosition(position: BrokerPosition): BrokerPosition {
  return {
    ...position,
    entryOrders: position.entryOrders.map((order) => ({ ...order })),
    exitOrders: position.exitOrders.map((order) => ({ ...order })),
    ...(position.stopOrder ? { stopOrder: { ...position.stopOrder } } : {}),
    ...(position.metadata ? { metadata: { ...position.metadata } } : {}),
    ...(position.setupKind ? { setupKind: position.setupKind } : {}),
  };
}

interface PaperBrokerExecutionOptions {
  feeRate?: number;
  slippageRate?: number;
}

export class PaperBroker implements Broker {
  readonly mode = "paper" as const;

  private readonly openPositions = new Map<string, BrokerPosition>();
  private readonly closedPositions: BrokerPosition[] = [];
  private readonly cancelledPositions: BrokerPosition[] = [];
  private readonly lastMarks = new Map<string, number>();
  private realizedPnlUsd = 0;
  private grossProfitUsd = 0;
  private grossLossUsd = 0;
  private totalFeesUsd = 0;
  private wins = 0;
  private losses = 0;
  private peakEquityUsd: number;
  private maxDrawdownPct = 0;
  private nextPositionSequence = 1;

  constructor(
    private readonly startingBalanceUsd: number,
    private readonly defaultPositionSizeUsd: number,
    private readonly executionOptions: PaperBrokerExecutionOptions = {},
  ) {
    this.peakEquityUsd = startingBalanceUsd;
  }

  async initialize(): Promise<string[]> {
    return [];
  }

  async onCycleStart(): Promise<string[]> {
    return [];
  }

  hasOpenPosition(symbol: string, strategyId: string): boolean {
    return this.getOpenPositions(symbol, strategyId).length > 0;
  }

  getOpenPositions(symbol: string, strategyId: string): BrokerPosition[] {
    return [...this.openPositions.values()].filter(
      (position) => position.symbol === symbol && position.strategyId === strategyId,
    );
  }

  async prepareSnapshot(): Promise<void> {}

  async openPosition(signal: StrategySignal): Promise<string[]> {
    const entryOrders = this.buildEntryOrders(signal);
    const intendedSizeUnits = entryOrders.reduce((sum, order) => sum + order.sizeUnits, 0);
    if (intendedSizeUnits <= POSITION_EPSILON) {
      return [
        `${signal.symbol}: paper broker skipped ${signal.strategyId} because entry size resolved to zero at stop ${signal.stopLoss.toFixed(2)}.`,
      ];
    }

    const exitOrders: PositionExitOrder[] = signal.exitOrders.map((order) => ({
      label: order.label,
      price: order.price,
      sizeFraction: order.sizeFraction ?? 0,
      sizeUnits: intendedSizeUnits * (order.sizeFraction ?? 0),
      status: "pending",
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

    const totalRiskUsd = entryOrders.reduce((sum, order) => sum + (order.riskBudgetUsd ?? 0), 0);
    const logs = [
      `${signal.symbol}: armed ${signal.side} ${signal.setupKind ?? "entry"} from ${entryOrders[0]?.price.toFixed(2)} to ${entryOrders.at(-1)?.price.toFixed(2)} with stop ${signal.stopLoss.toFixed(2)}.`,
      `${signal.symbol}: planned size ${intendedSizeUnits.toFixed(6)} units across ${entryOrders.length} entry orders${totalRiskUsd > 0 ? ` risking ${totalRiskUsd.toFixed(2)} USD at the stop` : ""}.`,
    ];
    if (signal.entryMode === "flip" && signal.netPositionBeforeEntry) {
      logs.push(
        `${signal.symbol}: flip entry will flatten the current ${signal.netPositionBeforeEntry.side} of ${signal.netPositionBeforeEntry.sizeUnits.toFixed(6)} units before opening new ${signal.side} exposure.`,
      );
    }

    for (const order of position.entryOrders) {
      if (!orderIsMarketable(position.side, order.price, signal.entryReferencePrice)) {
        continue;
      }

      logs.push(...this.fillEntryOrder(position, order, signal.generatedAt));
    }

    return logs;
  }

  async cancelPositionById(positionId: string, closedAt: number, reason: string, note?: string): Promise<string[]> {
    const position = this.openPositions.get(positionId);
    if (!position) {
      return [];
    }

    if (position.status !== "pending") {
      return [`${position.symbol}: skipped cancellation for ${position.id} because it is already ${position.status}.`];
    }

    return this.cancelPosition(position, closedAt, reason, note);
  }

  async processCandle(symbol: string, candle: Candle): Promise<string[]> {
    this.lastMarks.set(symbol, candle.close);

    const logs: string[] = [];
    const symbolPositions = [...this.openPositions.values()].filter((position) => position.symbol === symbol);

    for (const position of symbolPositions) {
      if (candle.closeTime <= position.signalTime || position.status === "closed" || position.status === "cancelled") {
        continue;
      }

      if (position.status === "pending" && candle.closeTime > position.expiryTime) {
        logs.push(...this.cancelPosition(position, candle.closeTime, "entry ladder expired before any fills"));
        continue;
      }

      for (const order of this.getPendingEntryOrders(position)) {
        if (!orderWasTouched(order.price, candle)) {
          continue;
        }

        logs.push(...this.fillEntryOrder(position, order, candle.closeTime));
      }

      if (position.status === "pending") {
        continue;
      }

      const stopWasHit =
        position.side === "long" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;

      if (stopWasHit) {
        logs.push(
          ...this.closeRemainingPosition(
            position,
            position.stopLoss,
            candle.closeTime,
            "stop loss hit",
            "Conservative rule: if entry, stop, and target were all inside one candle, fills happen first and the stop is assumed to beat the target.",
          ),
        );
        continue;
      }

      for (const exitOrder of this.getPendingExitOrders(position)) {
        if (!orderWasTouched(exitOrder.price, candle)) {
          continue;
        }

        logs.push(...this.fillExitOrder(position, exitOrder, candle.closeTime));
      }

      if (candle.closeTime > position.expiryTime) {
        for (const order of this.getPendingEntryOrders(position)) {
          order.status = "cancelled";
        }
      }

      if (position.remainingSizeUnits <= POSITION_EPSILON) {
        logs.push(...this.finishPosition(position, candle.closeTime, "exit ladder completed"));
      }
    }

    return logs;
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
  }

  async forceCloseAll(markPrices: Record<string, number>, closedAt: number, reason: string): Promise<string[]> {
    await this.recordEquity(markPrices);

    const logs: string[] = [];
    for (const position of [...this.openPositions.values()]) {
      const markPrice = markPrices[position.symbol] ?? this.lastMarks.get(position.symbol);
      if (!markPrice) {
        continue;
      }

      if (position.status === "pending") {
        logs.push(...this.cancelPosition(position, closedAt, reason));
        continue;
      }

      logs.push(...this.closeRemainingPosition(position, markPrice, closedAt, reason));
    }

    return logs;
  }

  snapshot(): BrokerSnapshot {
    const unrealizedPnlUsd = [...this.openPositions.values()].reduce((sum, position) => {
      if (position.status !== "open" || position.averageEntryPrice === undefined) {
        return sum;
      }

      const markPrice = this.lastMarks.get(position.symbol);
      if (!markPrice) {
        return sum;
      }

      return sum + calculatePnlUsd(position.side, position.averageEntryPrice, markPrice, position.remainingSizeUnits);
    }, 0);

    return {
      startingBalanceUsd: this.startingBalanceUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      lifetimeFundingUsd: 0,
      unrealizedPnlUsd,
      equityUsd: this.startingBalanceUsd + this.realizedPnlUsd + unrealizedPnlUsd,
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

  private buildEntryOrders(signal: StrategySignal): PositionEntryOrder[] {
    if (signal.maxRiskUsd !== undefined) {
      return signal.entryOrders.map((order) => {
        const riskFraction = order.riskFraction ?? order.sizeFraction ?? 0;
        const riskBudgetUsd = signal.maxRiskUsd! * riskFraction;
        const distanceToStop = stopDistance(signal.side, order.price, signal.stopLoss);
        const sizeUnits = distanceToStop <= POSITION_EPSILON ? 0 : riskBudgetUsd / distanceToStop;

        return {
          ...order,
          sizeUnits,
          riskBudgetUsd,
          status: "pending",
        };
      });
    }

    const positionSizeUsd = signal.positionSizeUsd ?? this.defaultPositionSizeUsd;
    const intendedSizeUnits = positionSizeUsd / signal.entryReferencePrice;

    return signal.entryOrders.map((order) => ({
      ...order,
      sizeUnits: intendedSizeUnits * (order.sizeFraction ?? order.riskFraction ?? 0),
      status: "pending",
    }));
  }

  private getPendingEntryOrders(position: BrokerPosition): PositionEntryOrder[] {
    return [...position.entryOrders]
      .filter((order) => order.status === "pending")
      .sort((left, right) => {
        if (position.side === "long") {
          return right.price - left.price;
        }

        return left.price - right.price;
      });
  }

  private getPendingExitOrders(position: BrokerPosition): PositionExitOrder[] {
    return [...position.exitOrders]
      .filter((order) => order.status === "pending")
      .sort((left, right) => {
        if (position.side === "long") {
          return left.price - right.price;
        }

        return right.price - left.price;
      });
  }

  private fillEntryOrder(position: BrokerPosition, order: PositionEntryOrder, filledAt: number): string[] {
    if (order.status !== "pending") {
      return [];
    }

    const executedPrice = this.applyExecutionSlippage(position.side, order.price, "entry");
    const logs =
      position.entryMode === "flip" ? this.clearOppositeExposureForFlip(position, executedPrice, filledAt) : [];
    const feeUsd = this.calculateFeeUsd(executedPrice, order.sizeUnits);

    order.status = "filled";
    order.filledAt = filledAt;
    order.filledSizeUnits = order.sizeUnits;
    order.averageFillPrice = executedPrice;
    order.feePaidUsd = feeUsd;

    const priorFilledSize = position.filledSizeUnits;
    const nextFilledSize = priorFilledSize + order.sizeUnits;
    const priorWeightedCost = (position.averageEntryPrice ?? 0) * priorFilledSize;
    const nextWeightedCost = priorWeightedCost + executedPrice * order.sizeUnits;

    position.filledSizeUnits = nextFilledSize;
    position.remainingSizeUnits += order.sizeUnits;
    position.averageEntryPrice = nextWeightedCost / nextFilledSize;
    position.status = "open";
    position.realizedPnlUsd -= feeUsd;
    this.realizedPnlUsd -= feeUsd;
    this.totalFeesUsd += feeUsd;

    logs.push(
      `${position.symbol}: ${order.label} filled at ${executedPrice.toFixed(2)} for ${(order.sizeUnits * executedPrice).toFixed(2)} USD notional. Fee ${feeUsd.toFixed(2)} USD. Avg entry ${position.averageEntryPrice.toFixed(2)}.`,
    );

    return logs;
  }

  private fillExitOrder(position: BrokerPosition, order: PositionExitOrder, closedAt: number): string[] {
    if (order.status !== "pending" || position.averageEntryPrice === undefined) {
      return [];
    }

    const sizeUnits = Math.min(position.remainingSizeUnits, order.sizeUnits);
    if (sizeUnits <= POSITION_EPSILON) {
      order.status = "cancelled";
      return [];
    }

    const executedPrice = this.applyExecutionSlippage(position.side, order.price, "exit");
    const feeUsd = this.calculateFeeUsd(executedPrice, sizeUnits);
    const realizedPnlUsd =
      calculatePnlUsd(position.side, position.averageEntryPrice, executedPrice, sizeUnits) - feeUsd;

    order.status = "filled";
    order.hitAt = closedAt;
    order.filledSizeUnits = sizeUnits;
    order.averageFillPrice = executedPrice;
    order.feePaidUsd = feeUsd;
    position.remainingSizeUnits -= sizeUnits;
    position.realizedPnlUsd += realizedPnlUsd;
    this.realizedPnlUsd += realizedPnlUsd;
    this.totalFeesUsd += feeUsd;

    return [
      `${position.symbol}: ${order.label} hit at ${executedPrice.toFixed(2)} for ${(sizeUnits * executedPrice).toFixed(2)} USD notional, fee ${feeUsd.toFixed(2)} USD, realized PnL ${realizedPnlUsd.toFixed(2)} USD.`,
    ];
  }

  private closeRemainingPosition(
    position: BrokerPosition,
    exitPrice: number,
    closedAt: number,
    closeReason: string,
    note?: string,
  ): string[] {
    if (position.averageEntryPrice === undefined) {
      return this.cancelPosition(position, closedAt, closeReason, note);
    }

    const remainingSizeUnits = position.remainingSizeUnits;
    const executedPrice = this.applyExecutionSlippage(position.side, exitPrice, "exit");
    const feeUsd = this.calculateFeeUsd(executedPrice, remainingSizeUnits);
    const realizedPnlUsd =
      calculatePnlUsd(position.side, position.averageEntryPrice, executedPrice, remainingSizeUnits) - feeUsd;

    position.remainingSizeUnits = 0;
    position.realizedPnlUsd += realizedPnlUsd;
    this.realizedPnlUsd += realizedPnlUsd;
    this.totalFeesUsd += feeUsd;

    const logs = [
      `${position.symbol}: ${closeReason} at ${executedPrice.toFixed(2)}, fee ${feeUsd.toFixed(2)} USD, realized PnL ${realizedPnlUsd.toFixed(2)} USD on remaining size.`,
    ];

    if (note) {
      logs.push(`${position.symbol}: ${note}`);
    }

    logs.push(...this.finishPosition(position, closedAt, closeReason));

    return logs;
  }

  private finishPosition(position: BrokerPosition, closedAt: number, closeReason: string): string[] {
    position.status = "closed";
    position.closeReason = closeReason;
    position.closedAt = closedAt;

    this.openPositions.delete(position.id);
    this.closedPositions.push(clonePosition(position));
    this.updateWinLossCounters(position.realizedPnlUsd);

    return [
      `${position.symbol}: position closed via ${closeReason}. Total realized PnL ${position.realizedPnlUsd.toFixed(2)} USD. Running balance ${(this.startingBalanceUsd + this.realizedPnlUsd).toFixed(2)} USD.`,
    ];
  }

  private cancelPosition(position: BrokerPosition, closedAt: number, closeReason: string, note?: string): string[] {
    position.status = "cancelled";
    position.closeReason = closeReason;
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

    this.openPositions.delete(position.id);
    this.cancelledPositions.push(clonePosition(position));

    return note ? [`${position.symbol}: ${closeReason}. ${note}`] : [`${position.symbol}: ${closeReason}.`];
  }

  private clearOppositeExposureForFlip(position: BrokerPosition, fillPrice: number, filledAt: number): string[] {
    const logs: string[] = [];
    const oppositePositions = [...this.openPositions.values()].filter(
      (candidate) =>
        candidate.id !== position.id &&
        candidate.symbol === position.symbol &&
        candidate.strategyId === position.strategyId &&
        candidate.side !== position.side,
    );

    for (const oppositePosition of oppositePositions) {
      if (oppositePosition.status === "pending") {
        logs.push(
          ...this.cancelPosition(
            oppositePosition,
            filledAt,
            `cancelled by opposing ${position.side} flip entry`,
            "Pending orders on the old side were cancelled before opening the new net position.",
          ),
        );
        continue;
      }

      if (oppositePosition.status === "open") {
        logs.push(
          ...this.closeRemainingPosition(
            oppositePosition,
            fillPrice,
            filledAt,
            `closed by opposing ${position.side} flip entry`,
            "Hyperliquid nets one position per symbol, so the old side is flattened before the new side opens.",
          ),
        );
      }
    }

    return logs;
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

  private applyExecutionSlippage(side: TradeSide, requestedPrice: number, phase: "entry" | "exit"): number {
    const slippageRate = this.executionOptions.slippageRate ?? 0;
    if (slippageRate <= 0) {
      return requestedPrice;
    }

    const buyAction = (side === "long" && phase === "entry") || (side === "short" && phase === "exit");
    return buyAction ? requestedPrice * (1 + slippageRate) : requestedPrice * (1 - slippageRate);
  }

  private calculateFeeUsd(price: number, sizeUnits: number): number {
    const feeRate = this.executionOptions.feeRate ?? 0;
    return price * sizeUnits * feeRate;
  }
}
