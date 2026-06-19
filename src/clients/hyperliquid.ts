import { z } from "zod";

import type { Candle, CandleInterval } from "../types.js";

const candleSnapshotSchema = z.array(
  z.object({
    t: z.number(),
    T: z.number(),
    s: z.string(),
    i: z.literal("4h"),
    o: z.string(),
    c: z.string(),
    h: z.string(),
    l: z.string(),
    v: z.string(),
    n: z.number(),
  }),
);

const INTERVAL_TO_MS: Record<CandleInterval, number> = {
  "4h": 4 * 60 * 60 * 1000,
};

const MAX_CANDLES_PER_REQUEST = 500;

export class HyperliquidClient {
  constructor(private readonly baseUrl: string) {}

  async fetchRecentClosedCandles(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const now = Date.now();
    const intervalMs = INTERVAL_TO_MS[interval];
    const startTime = now - intervalMs * (limit + 10);

    return this.fetchCandlesInRange(symbol, interval, startTime, now, limit);
  }

  async fetchCandlesInRange(
    symbol: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
    limit?: number,
  ): Promise<Candle[]> {
    const candleByOpenTime = new Map<number, Candle>();
    let cursorEndTime = endTime;
    const maxIterations = 100;
    let iterations = 0;

    while (cursorEndTime > startTime && (limit === undefined || candleByOpenTime.size < limit)) {
      if (++iterations > maxIterations) {
        console.error(`[hyperliquid] Candle pagination for ${symbol} exceeded ${maxIterations} iterations. Stopping to prevent infinite loop.`);
        break;
      }

      const pageCandles = await this.requestCandlePage(symbol, interval, cursorEndTime, MAX_CANDLES_PER_REQUEST);

      if (pageCandles.length === 0) {
        break;
      }

      for (const candle of pageCandles) {
        if (candle.closeTime <= endTime && candle.openTime >= startTime) {
          candleByOpenTime.set(candle.openTime, candle);
        }
      }

      const earliestCandle = pageCandles.at(0);
      if (!earliestCandle || earliestCandle.openTime <= startTime) {
        break;
      }

      cursorEndTime = earliestCandle.openTime - 1;

      if (pageCandles.length < MAX_CANDLES_PER_REQUEST) {
        break;
      }
    }

    const candles = [...candleByOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
    return limit === undefined ? candles : candles.slice(-limit);
  }

  private async requestCandlePage(
    symbol: string,
    interval: CandleInterval,
    endTime: number,
    candleCount: number,
  ): Promise<Candle[]> {
    const intervalMs = INTERVAL_TO_MS[interval];
    const startTime = endTime - intervalMs * candleCount;

    const response = await fetch(`${this.baseUrl}/info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin: symbol,
          interval,
          startTime,
          endTime,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Hyperliquid candle request failed for ${symbol}: ${response.status} ${errorBody}`);
    }

    const payload = candleSnapshotSchema.parse(await response.json());

    return payload
      .map((candle) => ({
        openTime: candle.t,
        closeTime: candle.T,
        symbol: candle.s,
        interval: candle.i,
        open: Number(candle.o),
        high: Number(candle.h),
        low: Number(candle.l),
        close: Number(candle.c),
        volume: Number(candle.v),
        trades: candle.n,
      }))
      .sort((left, right) => left.openTime - right.openTime);
  }
}
