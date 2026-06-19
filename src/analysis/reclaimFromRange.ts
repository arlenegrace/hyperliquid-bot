import type { BotConfig, Candle, RangeSnapshot, ReclaimEvent, TradeSide } from "../types.js";

function findLastMatchingIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item, index)) {
      return index;
    }
  }

  return -1;
}

export function findLatestReclaimEvent(
  candles: Candle[],
  range: RangeSnapshot,
  config: BotConfig,
): ReclaimEvent | undefined {
  const latestCandle = candles.at(-1);
  if (!latestCandle) {
    return undefined;
  }

  const recentCandles = candles.slice(-Math.max(config.reclaimLookbackCandles, 3));
  const latestIndex = recentCandles.length - 1;

  if (latestCandle.close >= range.low && latestCandle.close <= range.high) {
    const longDeviationIndex = findLastMatchingIndex(
      recentCandles,
      (candle, index) => index < latestIndex && candle.close < range.low,
    );
    if (longDeviationIndex >= 0) {
      const priorReclaim = recentCandles
        .slice(longDeviationIndex + 1, latestIndex)
        .some((candle) => candle.close >= range.low && candle.close <= range.high);
      const deviationCandle = recentCandles[longDeviationIndex];

      if (!priorReclaim && deviationCandle) {
        return {
          side: "long",
          deviationCandle,
          reclaimCandle: latestCandle,
        };
      }
    }

    const shortDeviationIndex = findLastMatchingIndex(
      recentCandles,
      (candle, index) => index < latestIndex && candle.close > range.high,
    );
    if (shortDeviationIndex >= 0) {
      const priorReclaim = recentCandles
        .slice(shortDeviationIndex + 1, latestIndex)
        .some((candle) => candle.close >= range.low && candle.close <= range.high);
      const deviationCandle = recentCandles[shortDeviationIndex];

      if (!priorReclaim && deviationCandle) {
        return {
          side: "short",
          deviationCandle,
          reclaimCandle: latestCandle,
        };
      }
    }
  }

  return undefined;
}

/** Last index strictly before `beforeIndex` whose close is inside `[range.low, range.high]`, or -1. */
export function findLastCloseInsideRangeIndex(
  candles: Candle[],
  range: RangeSnapshot,
  beforeIndex: number,
): number {
  return findLastMatchingIndex(candles, (candle, index) => {
    return index < beforeIndex && candle.close >= range.low && candle.close <= range.high;
  });
}

/**
 * Min low (long) or max high (short) across excursion candles from `lastInsideIdx + 1` through `throughIndex` inclusive.
 * If `lastInsideIdx < 0` or the window is empty, uses the deviation candle's low/high.
 */
export function excursionExtremeForStop(
  side: TradeSide,
  candles: Candle[],
  lastInsideIdx: number,
  throughIndex: number,
  deviationCandle: Candle,
): number {
  const start = lastInsideIdx + 1;
  if (lastInsideIdx < 0 || start > throughIndex) {
    return side === "long" ? deviationCandle.low : deviationCandle.high;
  }

  if (side === "long") {
    let minLow = Number.POSITIVE_INFINITY;
    for (let i = start; i <= throughIndex; i += 1) {
      const candle = candles[i];
      if (candle) {
        minLow = Math.min(minLow, candle.low);
      }
    }
    return Number.isFinite(minLow) ? minLow : deviationCandle.low;
  }

  let maxHigh = Number.NEGATIVE_INFINITY;
  for (let i = start; i <= throughIndex; i += 1) {
    const candle = candles[i];
    if (candle) {
      maxHigh = Math.max(maxHigh, candle.high);
    }
  }
  return Number.isFinite(maxHigh) ? maxHigh : deviationCandle.high;
}
