import {
  excursionExtremeForStop,
  findLastCloseInsideRangeIndex,
  findLatestReclaimEvent,
} from "../src/analysis/reclaimFromRange.js";
import { formatPerpPriceForConsole, wrapOrange } from "../src/consoleFormat.js";
import { buildManualRangeSnapshot } from "../src/manualRanges.js";
import type {
  StrategyContext,
  StrategyResult,
  TradingStrategy,
} from "../src/types.js";
import { buildRangeEntryOrders, buildRangeExitOrders } from "./ladderUtils.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export class ManualRangeTradingV3Strategy implements TradingStrategy {
  readonly id = "manual-range-trading-v3";
  readonly description =
    "Like manual range v1, but stop loss uses the excursion extreme (min low / max high) since the last close inside the range, not only the reclaim deviation candle.";

  evaluate(context: StrategyContext): StrategyResult {
    if (!context.manualRange) {
      return {
        notes: [`${context.symbol}: no manual range configured for ${this.id}.`],
      };
    }

    if (context.manualRangeState?.isInvalidated) {
      return {
        notes: [
          `${context.symbol}: manual range is invalidated for ${this.id}. ${context.manualRangeState.invalidationReason ?? ""}`.trim(),
        ],
      };
    }

    if (context.hasOpenPosition) {
      return {
        notes: [
          `${context.symbol}: skipped ${this.id} because a position or ladder plan is already active; v3 only re-arms after the current net position is fully flat.`,
        ],
      };
    }

    const validFromTime = context.manualRange.validFromTime ?? 0;
    const activeCandles = context.candles.filter((candle) => candle.closeTime >= validFromTime);
    const signalCandle = activeCandles.at(-1);
    if (!signalCandle) {
      return {
        notes: [`${context.symbol}: manual range exists but there are no candles after its valid-from time.`],
      };
    }

    const range = buildManualRangeSnapshot(
      context.manualRange,
      signalCandle.closeTime,
      context.config.rangeLookbackCandles,
    );
    const reclaimEvent = findLatestReclaimEvent(activeCandles, range, context.config);

    if (!reclaimEvent) {
      return {
        notes: [
          `${context.symbol}: manual range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} is active, but no fresh reclaim setup exists on the newest closed candle for ${wrapOrange(this.id)}.`,
        ],
      };
    }

    const signalIndex = activeCandles.length - 1;
    const lastInsideIdx = findLastCloseInsideRangeIndex(activeCandles, range, signalIndex);
    const stopAnchor = excursionExtremeForStop(
      reclaimEvent.side,
      activeCandles,
      lastInsideIdx,
      signalIndex,
      reclaimEvent.deviationCandle,
    );
    const entryBandWidth = range.width * context.config.ladderEntryBandPct;

    if (reclaimEvent.side === "long") {
      const upperEntry = Math.min(signalCandle.close, range.low + entryBandWidth);
      const exitStart = range.low + range.width * context.config.ladderExitStartPct;
      const exitEnd = range.low + range.width * context.config.ladderExitEndPct;

      return {
        notes: [
          `${context.symbol}: manual v3 long reclaim confirmed inside range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} (excursion-based stop).`,
        ],
        signal: {
          strategyId: this.id,
          symbol: context.symbol,
          side: "long",
          entryReferencePrice: signalCandle.close,
          stopLoss: stopAnchor * (1 - context.config.stopBufferPct),
          entryOrders: buildRangeEntryOrders("long", range.low, upperEntry, context.config.ladderLevels),
          exitOrders: buildRangeExitOrders("long", exitStart, exitEnd, context.config.ladderLevels),
          range,
          triggerCandle: signalCandle,
          deviationCandle: reclaimEvent.deviationCandle,
          reason:
            "Manual range v3: same reclaim as v1, but stop uses the lowest low since the last close inside the range (excursion), with buffer.",
          generatedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
          positionSizeUsd: context.config.positionSizeUsd,
        },
      };
    }

    const lowerEntry = Math.max(signalCandle.close, range.high - entryBandWidth);
    const exitStart = range.high - range.width * context.config.ladderExitStartPct;
    const exitEnd = range.high - range.width * context.config.ladderExitEndPct;

    return {
      notes: [
        `${context.symbol}: manual v3 short reclaim confirmed inside range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} (excursion-based stop).`,
      ],
      signal: {
        strategyId: this.id,
        symbol: context.symbol,
        side: "short",
        entryReferencePrice: signalCandle.close,
        stopLoss: stopAnchor * (1 + context.config.stopBufferPct),
        entryOrders: buildRangeEntryOrders("short", lowerEntry, range.high, context.config.ladderLevels),
        exitOrders: buildRangeExitOrders("short", exitStart, exitEnd, context.config.ladderLevels),
        range,
        triggerCandle: signalCandle,
        deviationCandle: reclaimEvent.deviationCandle,
        reason:
          "Manual range v3: same reclaim as v1, but stop uses the highest high since the last close inside the range (excursion), with buffer.",
        generatedAt: signalCandle.closeTime,
        expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
        positionSizeUsd: context.config.positionSizeUsd,
      },
    };
  }
}
