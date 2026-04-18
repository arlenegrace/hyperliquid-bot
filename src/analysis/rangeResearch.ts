import { fileURLToPath } from "node:url";

import { HyperliquidClient } from "../clients/hyperliquid.js";
import { formatConsoleSymbol, formatConsoleTimestamp } from "../consoleFormat.js";
import { loadConfig } from "../config.js";
import type {
  BotConfig,
  Candle,
  PivotCluster,
  PivotPoint,
  RangeSnapshot,
  TradeSide,
} from "../types.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const RESEARCH_START_TIME = Date.UTC(2026, 0, 15, 0, 0, 0, 0);
const RESEARCH_END_TIME = Date.UTC(2027, 2, 28, 23, 59, 59, 999);

interface ResearchTimestamp {
  label: string;
  timestamp: number;
}

export interface ReclaimEvent {
  side: TradeSide;
  deviationCandle: Candle;
  reclaimCandle: Candle;
}

const USER_RESEARCH_TIMESTAMPS: ResearchTimestamp[] = [
  { label: "Range high reference", timestamp: Date.UTC(2026, 1, 8, 20, 0, 0, 0) },
  { label: "Range low reference", timestamp: Date.UTC(2026, 1, 12, 16, 0, 0, 0) },
  { label: "Deviation below reference", timestamp: Date.UTC(2026, 1, 23, 0, 0, 0, 0) },
  { label: "Reclaim below reference", timestamp: Date.UTC(2026, 1, 25, 0, 0, 0, 0) },
  { label: "Deviation above reference", timestamp: Date.UTC(2026, 2, 4, 12, 0, 0, 0) },
  { label: "Reclaim above reference", timestamp: Date.UTC(2026, 2, 5, 4, 0, 0, 0) },
];

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatTimestamp(timestamp: number): string {
  return formatConsoleTimestamp(timestamp);
}

function priceWithinTolerance(price: number, level: number, tolerancePct: number): boolean {
  return Math.abs(price - level) / level <= tolerancePct;
}

function roundPrice(price: number): string {
  if (price >= 100) {
    return price.toFixed(2);
  }

  if (price >= 1) {
    return price.toFixed(3);
  }

  return price.toFixed(4);
}

function levelTouched(candle: Candle, price: number): boolean {
  return candle.low <= price && candle.high >= price;
}

function findLastMatchingIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item, index)) {
      return index;
    }
  }

  return -1;
}

export function collectPivotPoints(candles: Candle[], strength: number): PivotPoint[] {
  const pivots: PivotPoint[] = [];

  for (let index = strength; index < candles.length - strength; index += 1) {
    const candle = candles[index];
    if (!candle) {
      continue;
    }

    let isPivotHigh = true;
    let isPivotLow = true;

    for (let offset = 1; offset <= strength; offset += 1) {
      const left = candles[index - offset];
      const right = candles[index + offset];

      if (!left || !right) {
        isPivotHigh = false;
        isPivotLow = false;
        break;
      }

      if (candle.high <= left.high || candle.high <= right.high) {
        isPivotHigh = false;
      }

      if (candle.low >= left.low || candle.low >= right.low) {
        isPivotLow = false;
      }
    }

    if (isPivotHigh) {
      pivots.push({
        type: "high",
        index,
        price: candle.high,
        candle,
      });
    }

    if (isPivotLow) {
      pivots.push({
        type: "low",
        index,
        price: candle.low,
        candle,
      });
    }
  }

  return pivots;
}

export function clusterPivotPoints(points: PivotPoint[], tolerancePct: number): PivotCluster[] {
  const clusters: PivotCluster[] = [];
  const sortedPoints = [...points].sort((left, right) => left.price - right.price);

  for (const point of sortedPoints) {
    const matchingCluster = clusters.find(
      (cluster) => cluster.type === point.type && priceWithinTolerance(point.price, cluster.level, tolerancePct),
    );

    if (matchingCluster) {
      matchingCluster.points.push(point);
      matchingCluster.touchCount = matchingCluster.points.length;
      matchingCluster.level = average(matchingCluster.points.map((entry) => entry.price));
      matchingCluster.firstTouchIndex = Math.min(matchingCluster.firstTouchIndex, point.index);
      matchingCluster.lastTouchIndex = Math.max(matchingCluster.lastTouchIndex, point.index);
      matchingCluster.firstTouchTime = Math.min(matchingCluster.firstTouchTime, point.candle.openTime);
      matchingCluster.lastTouchTime = Math.max(matchingCluster.lastTouchTime, point.candle.closeTime);
      continue;
    }

    clusters.push({
      type: point.type,
      level: point.price,
      tolerancePct,
      points: [point],
      touchCount: 1,
      firstTouchIndex: point.index,
      lastTouchIndex: point.index,
      firstTouchTime: point.candle.openTime,
      lastTouchTime: point.candle.closeTime,
    });
  }

  return clusters.sort((left, right) => {
    if (right.touchCount !== left.touchCount) {
      return right.touchCount - left.touchCount;
    }

    return right.lastTouchIndex - left.lastTouchIndex;
  });
}

export function findAnchoredRange(candles: Candle[], config: BotConfig): RangeSnapshot | undefined {
  if (candles.length < config.pivotStrength * 2 + config.rangeMinBoundaryTouches) {
    return undefined;
  }

  const lookbackWindow = candles.slice(-config.rangeLookbackCandles);
  const windowStart = lookbackWindow.at(0);
  const windowEnd = lookbackWindow.at(-1);
  if (!windowStart || !windowEnd) {
    return undefined;
  }

  const pivots = collectPivotPoints(lookbackWindow, config.pivotStrength);
  const highPivots = pivots.filter((pivot) => pivot.type === "high");
  const lowPivots = pivots.filter((pivot) => pivot.type === "low");

  const latestIndex = lookbackWindow.length - 1;
  let bestCandidate: { range: RangeSnapshot; score: number } | undefined;

  for (const highPivot of highPivots) {
    for (const lowPivot of lowPivots) {
      if (highPivot.price <= lowPivot.price) {
        continue;
      }

      const width = highPivot.price - lowPivot.price;
      const mid = lowPivot.price + width / 2;
      const widthPct = width / mid;

      if (widthPct < config.rangeMinWidthPct || widthPct > config.rangeMaxWidthPct) {
        continue;
      }

      const anchorStartIndex = Math.min(highPivot.index, lowPivot.index);
      const anchorEndIndex = Math.max(highPivot.index, lowPivot.index);
      const ageCandles = latestIndex - anchorEndIndex;
      const anchorGap = anchorEndIndex - anchorStartIndex;

      if (ageCandles > config.rangeMaxAgeCandles || anchorGap > Math.max(8, Math.floor(config.rangeMaxAgeCandles / 2))) {
        continue;
      }

      const activeWindow = lookbackWindow.slice(anchorStartIndex);
      const insideWindow = lookbackWindow.slice(anchorEndIndex);
      if (insideWindow.length === 0) {
        continue;
      }

      const insideCloses = insideWindow.filter(
        (candle) => candle.close >= lowPivot.price && candle.close <= highPivot.price,
      ).length;
      const insideRatio = insideCloses / insideWindow.length;

      if (insideRatio < config.rangeInsideCloseRatio) {
        continue;
      }

      const highRetests = activeWindow.filter(
        (candle) =>
          priceWithinTolerance(candle.high, highPivot.price, config.pivotClusterTolerancePct) ||
          priceWithinTolerance(candle.close, highPivot.price, config.pivotClusterTolerancePct / 2),
      ).length;
      const lowRetests = activeWindow.filter(
        (candle) =>
          priceWithinTolerance(candle.low, lowPivot.price, config.pivotClusterTolerancePct) ||
          priceWithinTolerance(candle.close, lowPivot.price, config.pivotClusterTolerancePct / 2),
      ).length;
      if (highRetests < config.rangeMinBoundaryTouches || lowRetests < config.rangeMinBoundaryTouches) {
        continue;
      }

      const outsideCloseCount = insideWindow.filter(
        (candle) => candle.close < lowPivot.price || candle.close > highPivot.price,
      ).length;
      const confidenceScore =
        insideRatio * 100 +
        highRetests * 8 +
        lowRetests * 8 +
        widthPct * 600 -
        ageCandles -
        outsideCloseCount * 8;

      const range: RangeSnapshot = {
        high: highPivot.price,
        low: lowPivot.price,
        mid,
        width,
        widthPct,
        lookbackCandles: lookbackWindow.length,
        startTime: lookbackWindow[anchorStartIndex]?.openTime ?? windowStart.openTime,
        endTime: lookbackWindow[latestIndex]?.closeTime ?? windowEnd.closeTime,
        anchorHighTime: highPivot.candle.closeTime,
        anchorLowTime: lowPivot.candle.closeTime,
        highTouchCount: highRetests,
        lowTouchCount: lowRetests,
        source: "pivot-cluster",
        confidenceScore,
      };

      const score = confidenceScore - Math.abs(highRetests - lowRetests) * 3 - anchorGap * 0.5;

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { range, score };
      }
    }
  }

  return bestCandidate?.range;
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
    return minLow;
  }

  let maxHigh = Number.NEGATIVE_INFINITY;
  for (let i = start; i <= throughIndex; i += 1) {
    const candle = candles[i];
    if (candle) {
      maxHigh = Math.max(maxHigh, candle.high);
    }
  }
  return maxHigh;
}

function findNearestCandle(candles: Candle[], timestamp: number): Candle | undefined {
  let nearestCandle: Candle | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const candle of candles) {
    const distance = Math.abs(candle.openTime - timestamp);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestCandle = candle;
    }
  }

  return nearestCandle;
}

function describeCandle(candle: Candle): string {
  return `${formatTimestamp(candle.openTime)} | O ${roundPrice(candle.open)} H ${roundPrice(candle.high)} L ${roundPrice(candle.low)} C ${roundPrice(candle.close)}`;
}

export async function buildRangeResearchReport(
  client: HyperliquidClient,
  config: BotConfig,
  symbols: string[] = ["BTC", "ETH"],
): Promise<string[]> {
  const reportLines: string[] = [];

  for (const symbol of symbols) {
    const candles = await client.fetchCandlesInRange(
      symbol,
      config.interval,
      RESEARCH_START_TIME,
      RESEARCH_END_TIME,
    );

    reportLines.push(`${formatConsoleSymbol(symbol)}: loaded ${candles.length} candles for research.`);

    for (const point of USER_RESEARCH_TIMESTAMPS) {
      const candle = findNearestCandle(candles, point.timestamp);
      if (!candle) {
        reportLines.push(`${formatConsoleSymbol(symbol)}: ${point.label} -> no nearby candle.`);
        continue;
      }

      reportLines.push(`${formatConsoleSymbol(symbol)}: ${point.label} -> ${describeCandle(candle)}`);
    }

    const reclaimReference = USER_RESEARCH_TIMESTAMPS.at(-1)?.timestamp ?? RESEARCH_END_TIME;
    const candlesThroughReference = candles.filter((candle) => candle.closeTime <= reclaimReference);
    const range = findAnchoredRange(candlesThroughReference, config);

    if (!range) {
      reportLines.push(`${formatConsoleSymbol(symbol)}: no anchored range detected through the March reclaim reference.`);
      continue;
    }

    reportLines.push(
      `${formatConsoleSymbol(symbol)}: anchored range ${roundPrice(range.low)} - ${roundPrice(range.high)} (${(range.widthPct * 100).toFixed(2)}%) with confidence ${range.confidenceScore.toFixed(2)}.`,
    );

    const reclaimEvent = findLatestReclaimEvent(candlesThroughReference, range, config);
    if (reclaimEvent) {
      reportLines.push(
        `${formatConsoleSymbol(symbol)}: latest ${reclaimEvent.side} reclaim detected from ${formatTimestamp(reclaimEvent.deviationCandle.openTime)} to ${formatTimestamp(reclaimEvent.reclaimCandle.openTime)}.`,
      );
    } else {
      reportLines.push(`${formatConsoleSymbol(symbol)}: no reclaim event detected at the March reference using the anchored range rules.`);
    }
  }

  return reportLines;
}

async function runCli(): Promise<void> {
  const config = loadConfig();
  const client = new HyperliquidClient(config.apiBaseUrl);
  const lines = await buildRangeResearchReport(client, config);

  for (const line of lines) {
    console.log(line);
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  void runCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
