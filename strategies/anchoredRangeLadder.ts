import {
  findAnchoredRange,
  findLatestReclaimEvent,
} from "../src/analysis/rangeResearch.js";
import { formatPerpPriceForConsole } from "../src/consoleFormat.js";
import type {
  StrategyContext,
  StrategyResult,
  TradingStrategy,
} from "../src/types.js";
import { buildRangeEntryOrders, buildRangeExitOrders } from "./ladderUtils.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export class AnchoredRangeLadderStrategy implements TradingStrategy {
  readonly id = "anchored-range-ladder";
  readonly description =
    "Uses pivot-cluster anchored ranges, waits for close-based deviation and reclaim, then ladders entries and exits in five equal slices.";

  evaluate(context: StrategyContext): StrategyResult {
    if (context.hasOpenPosition) {
      return {
        notes: [`${context.symbol}: skipped ${this.id} because a position or ladder plan is already active.`],
      };
    }

    const signalCandle = context.candles.at(-1);
    if (!signalCandle) {
      return {
        notes: [`${context.symbol}: no closed candle available for ${this.id}.`],
      };
    }

    const history = context.candles.slice(0, -1);
    const range = findAnchoredRange(history, context.config);

    if (!range) {
      return {
        notes: [`${context.symbol}: no anchored range found for ${this.id}.`],
      };
    }

    const reclaimEvent = findLatestReclaimEvent(context.candles, range, context.config);
    if (!reclaimEvent) {
      return {
        notes: [
          `${context.symbol}: anchored range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} is active, but no fresh reclaim setup exists.`,
        ],
      };
    }

    const entryBandWidth = range.width * context.config.ladderEntryBandPct;

    if (reclaimEvent.side === "long") {
      const upperEntry = Math.min(signalCandle.close, range.low + entryBandWidth);
      const entryOrders = buildRangeEntryOrders("long", range.low, upperEntry, context.config.ladderLevels);
      const exitStart = range.low + range.width * context.config.ladderExitStartPct;
      const exitEnd = range.low + range.width * context.config.ladderExitEndPct;

      return {
        notes: [
          `${context.symbol}: long reclaim confirmed inside anchored range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)}.`,
        ],
        signal: {
          strategyId: this.id,
          symbol: context.symbol,
          side: "long",
          entryReferencePrice: signalCandle.close,
          stopLoss: reclaimEvent.deviationCandle.low * (1 - context.config.stopBufferPct),
          entryOrders,
          exitOrders: buildRangeExitOrders("long", exitStart, exitEnd, context.config.ladderLevels),
          range,
          triggerCandle: signalCandle,
          deviationCandle: reclaimEvent.deviationCandle,
          reason:
            "Anchored range stayed intact, a recent 4h close deviated below support, and the newest candle reclaimed back inside the band.",
          generatedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
        },
      };
    }

    const lowerEntry = Math.max(signalCandle.close, range.high - entryBandWidth);
    const entryOrders = buildRangeEntryOrders("short", lowerEntry, range.high, context.config.ladderLevels);
    const exitStart = range.high - range.width * context.config.ladderExitStartPct;
    const exitEnd = range.high - range.width * context.config.ladderExitEndPct;

    return {
      notes: [
        `${context.symbol}: short reclaim confirmed inside anchored range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)}.`,
      ],
      signal: {
        strategyId: this.id,
        symbol: context.symbol,
        side: "short",
        entryReferencePrice: signalCandle.close,
        stopLoss: reclaimEvent.deviationCandle.high * (1 + context.config.stopBufferPct),
        entryOrders,
        exitOrders: buildRangeExitOrders("short", exitStart, exitEnd, context.config.ladderLevels),
        range,
        triggerCandle: signalCandle,
        deviationCandle: reclaimEvent.deviationCandle,
        reason:
          "Anchored range stayed intact, a recent 4h close deviated above resistance, and the newest candle reclaimed back inside the band.",
        generatedAt: signalCandle.closeTime,
        expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
      },
    };
  }
}
