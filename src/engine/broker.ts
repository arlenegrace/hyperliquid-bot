import type { BrokerPosition, BrokerSnapshot, Candle, StrategySignal } from "../types.js";

export interface Broker {
  readonly mode: "paper" | "live";

  initialize(): Promise<string[]>;
  onCycleStart(): Promise<string[]>;

  hasOpenPosition(symbol: string, strategyId: string): boolean;
  getOpenPositions(symbol: string, strategyId: string): BrokerPosition[];
  snapshot(): BrokerSnapshot;

  openPosition(signal: StrategySignal): Promise<string[]>;
  cancelPositionById(positionId: string, closedAt: number, reason: string, note?: string): Promise<string[]>;
  processCandle(symbol: string, candle: Candle): Promise<string[]>;
  recordEquity(markPrices: Record<string, number>): Promise<void>;
}
