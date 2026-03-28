import { findAnchoredRange } from "../src/analysis/rangeResearch.js";
import type {
  StrategyContext,
  StrategyResult,
  TradingStrategy,
} from "../src/types.js";
import { buildRangeEntryOrders, buildRangeExitOrders } from "./ladderUtils.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export class PivotClusterMeanReversionStrategy implements TradingStrategy {
  readonly id = "pivot-cluster-mean-reversion";
  readonly description =
    "Trades only the outer bands of a high-confidence anchored range and avoids fresh breakout-reclaim states for smoother drawdowns.";

  evaluate(context: StrategyContext): StrategyResult {
    if (context.hasOpenPosition) {
      return {
        notes: [`${context.symbol}: skipped ${this.id} because a position or ladder plan is already active.`],
      };
    }

    const signalCandle = context.candles.at(-1);
    const previousCandle = context.candles.at(-2);
    if (!signalCandle || !previousCandle) {
      return {
        notes: [`${context.symbol}: not enough candles for ${this.id}.`],
      };
    }

    const history = context.candles.slice(0, -1);
    const range = findAnchoredRange(history, context.config);

    if (!range) {
      return {
        notes: [`${context.symbol}: no anchored range found for ${this.id}.`],
      };
    }

    if (range.highTouchCount < context.config.rangeMinBoundaryTouches + 1) {
      return {
        notes: [`${context.symbol}: range confidence too low for ${this.id}.`],
      };
    }

    const outerBandWidth = range.width * context.config.ladderEntryBandPct;
    const lowerBandCeiling = range.low + outerBandWidth;
    const upperBandFloor = range.high - outerBandWidth;
    const recentCloses = context.candles
      .slice(-context.config.pivotStrength * 2)
      .filter((candle) => candle.close >= range.low && candle.close <= range.high);

    if (recentCloses.length < Math.max(2, context.config.pivotStrength)) {
      return {
        notes: [`${context.symbol}: recent candles were not stable enough inside the range for ${this.id}.`],
      };
    }

    if (
      signalCandle.close >= range.low &&
      signalCandle.close <= lowerBandCeiling &&
      signalCandle.close >= signalCandle.open &&
      signalCandle.close >= previousCandle.close
    ) {
      const entryUpper = Math.min(signalCandle.close, lowerBandCeiling);

      return {
        notes: [
          `${context.symbol}: long edge mean reversion setup found inside anchored range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}.`,
        ],
        signal: {
          strategyId: this.id,
          symbol: context.symbol,
          side: "long",
          entryReferencePrice: signalCandle.close,
          stopLoss: range.low * (1 - context.config.stopBufferPct),
          entryOrders: buildRangeEntryOrders("long", range.low, entryUpper, context.config.ladderLevels),
          exitOrders: buildRangeExitOrders(
            "long",
            range.low + range.width * context.config.ladderExitStartPct,
            range.low + range.width * context.config.ladderExitEndPct,
            context.config.ladderLevels,
          ),
          range,
          triggerCandle: signalCandle,
          reason:
            "Price held inside a high-confidence pivot-cluster range and bounced from the lower band without needing a full breakout-reclaim sequence.",
          generatedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
        },
      };
    }

    if (
      signalCandle.close <= range.high &&
      signalCandle.close >= upperBandFloor &&
      signalCandle.close <= signalCandle.open &&
      signalCandle.close <= previousCandle.close
    ) {
      const entryLower = Math.max(signalCandle.close, upperBandFloor);

      return {
        notes: [
          `${context.symbol}: short edge mean reversion setup found inside anchored range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}.`,
        ],
        signal: {
          strategyId: this.id,
          symbol: context.symbol,
          side: "short",
          entryReferencePrice: signalCandle.close,
          stopLoss: range.high * (1 + context.config.stopBufferPct),
          entryOrders: buildRangeEntryOrders("short", entryLower, range.high, context.config.ladderLevels),
          exitOrders: buildRangeExitOrders(
            "short",
            range.high - range.width * context.config.ladderExitStartPct,
            range.high - range.width * context.config.ladderExitEndPct,
            context.config.ladderLevels,
          ),
          range,
          triggerCandle: signalCandle,
          reason:
            "Price held inside a high-confidence pivot-cluster range and rotated down from the upper band without waiting for an external deviation.",
          generatedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
        },
      };
    }

    return {
      notes: [
        `${context.symbol}: no edge mean reversion setup. Range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}, close ${signalCandle.close.toFixed(2)}.`,
      ],
    };
  }
}
