import type { Candle, CandleInterval } from "../types.js";

interface CandleStoreOptions {
  interval: CandleInterval;
  maxCandlesPerSymbol: number;
  candleCloseGraceMs: number;
}

export class CandleStore {
  private readonly candlesBySymbol = new Map<string, Map<number, Candle>>();
  private readonly lastEmittedCloseTimeBySymbol = new Map<string, number>();
  private readonly latestEventTimeBySymbol = new Map<string, number>();

  constructor(private readonly options: CandleStoreOptions) {}

  seed(symbol: string, candles: Candle[]): void {
    const normalizedSymbol = symbol.toUpperCase();
    for (const candle of candles) {
      this.upsert(normalizedSymbol, candle, { updateEventTime: false });
    }
  }

  upsertFromStream(candle: Candle, receivedAt = Date.now()): Candle | undefined {
    const normalizedSymbol = candle.symbol.toUpperCase();
    this.latestEventTimeBySymbol.set(normalizedSymbol, receivedAt);
    return this.upsert(normalizedSymbol, candle, { updateEventTime: false });
  }

  getCandles(symbol: string): Candle[] {
    const candles = this.candlesBySymbol.get(symbol.toUpperCase());
    if (!candles) {
      return [];
    }

    return [...candles.values()].sort((left, right) => left.openTime - right.openTime);
  }

  getLatestEventTime(symbol: string): number | undefined {
    return this.latestEventTimeBySymbol.get(symbol.toUpperCase());
  }

  collectNewClosedCandles(now = Date.now()): Map<string, Candle[]> {
    const readyBySymbol = new Map<string, Candle[]>();
    const closeCutoff = now - this.options.candleCloseGraceMs;

    for (const [symbol, candleMap] of this.candlesBySymbol.entries()) {
      const lastEmittedCloseTime = this.lastEmittedCloseTimeBySymbol.get(symbol) ?? 0;
      const ready = [...candleMap.values()]
        .filter((candle) => candle.interval === this.options.interval)
        .filter((candle) => candle.closeTime <= closeCutoff && candle.closeTime > lastEmittedCloseTime)
        .sort((left, right) => left.closeTime - right.closeTime || left.openTime - right.openTime);

      if (ready.length === 0) {
        continue;
      }

      this.lastEmittedCloseTimeBySymbol.set(symbol, ready.at(-1)!.closeTime);
      readyBySymbol.set(symbol, ready);
    }

    return readyBySymbol;
  }

  markProcessed(symbol: string, closeTime: number): void {
    const normalizedSymbol = symbol.toUpperCase();
    const current = this.lastEmittedCloseTimeBySymbol.get(normalizedSymbol) ?? 0;
    this.lastEmittedCloseTimeBySymbol.set(normalizedSymbol, Math.max(current, closeTime));
  }

  private upsert(symbol: string, candle: Candle, options: { updateEventTime: boolean }): Candle | undefined {
    if (candle.interval !== this.options.interval) {
      return undefined;
    }

    let candles = this.candlesBySymbol.get(symbol);
    if (!candles) {
      candles = new Map<number, Candle>();
      this.candlesBySymbol.set(symbol, candles);
    }

    const normalizedCandle = {
      ...candle,
      symbol,
    };
    candles.set(normalizedCandle.openTime, normalizedCandle);
    this.trim(symbol, candles);

    if (options.updateEventTime) {
      this.latestEventTimeBySymbol.set(symbol, Date.now());
    }

    return normalizedCandle;
  }

  private trim(symbol: string, candles: Map<number, Candle>): void {
    const excess = candles.size - this.options.maxCandlesPerSymbol;
    if (excess <= 0) {
      return;
    }

    const sortedOpenTimes = [...candles.keys()].sort((left, right) => left - right);
    for (const openTime of sortedOpenTimes.slice(0, excess)) {
      candles.delete(openTime);
    }

    if (candles.size === 0) {
      this.candlesBySymbol.delete(symbol);
    }
  }
}
