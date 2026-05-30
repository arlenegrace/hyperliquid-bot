import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../types.js";
import { CandleStore } from "./candleStore.js";

function createCandle(openTime: number, overrides: Partial<Candle> = {}): Candle {
  return {
    openTime,
    closeTime: openTime + 4 * 60 * 60 * 1000 - 1,
    symbol: "BTC",
    interval: "4h",
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1,
    trades: 10,
    ...overrides,
  };
}

test("candle store emits each closed candle once", () => {
  const store = new CandleStore({
    interval: "4h",
    maxCandlesPerSymbol: 10,
    candleCloseGraceMs: 1_000,
  });
  const candle = createCandle(0);

  store.upsertFromStream(candle, 1);
  store.upsertFromStream({ ...candle, close: 106 }, 2);

  const first = store.collectNewClosedCandles(candle.closeTime + 1_000);
  assert.equal(first.get("BTC")?.length, 1);
  assert.equal(first.get("BTC")?.[0]?.close, 106);

  const second = store.collectNewClosedCandles(candle.closeTime + 2_000);
  assert.equal(second.size, 0);
});

test("candle store ignores in-progress candles until the close grace has elapsed", () => {
  const store = new CandleStore({
    interval: "4h",
    maxCandlesPerSymbol: 10,
    candleCloseGraceMs: 10_000,
  });
  const candle = createCandle(0);

  store.upsertFromStream(candle);

  assert.equal(store.collectNewClosedCandles(candle.closeTime + 9_999).size, 0);
  assert.equal(store.collectNewClosedCandles(candle.closeTime + 10_000).get("BTC")?.length, 1);
});

test("candle store sorts out-of-order updates and trims old candles", () => {
  const store = new CandleStore({
    interval: "4h",
    maxCandlesPerSymbol: 2,
    candleCloseGraceMs: 0,
  });
  const first = createCandle(0);
  const second = createCandle(10);
  const third = createCandle(20);

  store.seed("BTC", [third, first, second]);

  assert.deepEqual(
    store.getCandles("BTC").map((candle) => candle.openTime),
    [10, 20],
  );
});
