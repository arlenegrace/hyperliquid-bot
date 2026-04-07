import { findLatestReclaimEvent } from "../src/analysis/rangeResearch.js";
import { wrapOrange } from "../src/consoleFormat.js";
import { buildManualRangeSnapshot } from "../src/manualRanges.js";
import type {
  StrategyContext,
  StrategyResult,
  TradingStrategy,
} from "../src/types.js";
import { buildRangeEntryOrders, buildRangeExitOrders } from "./ladderUtils.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export class ManualRangeTradingV1Strategy implements TradingStrategy {
  readonly id = "manual-range-trading-v1";
  readonly description =
    "Recreates the original manual range strategy: close-based deviation and reclaim, equal ladder entries near the edge, and equal ladder exits across the range.";

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
          `${context.symbol}: skipped ${this.id} because a position or ladder plan is already active; v1 only re-arms after the current net position is fully flat.`,
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
          `${context.symbol}: manual range ${range.low.toFixed(2)} - ${range.high.toFixed(2)} is active, but no fresh reclaim setup exists on the newest closed candle for ${wrapOrange(this.id)}.`,
        ],
      };
    }

    const entryBandWidth = range.width * context.config.ladderEntryBandPct;

    if (reclaimEvent.side === "long") {
      const upperEntry = Math.min(signalCandle.close, range.low + entryBandWidth);
      const exitStart = range.low + range.width * context.config.ladderExitStartPct;
      const exitEnd = range.low + range.width * context.config.ladderExitEndPct;

      return {
        notes: [
          `${context.symbol}: manual v1 long reclaim confirmed inside range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}.`,
        ],
        signal: {
          strategyId: this.id,
          symbol: context.symbol,
          side: "long",
          entryReferencePrice: signalCandle.close,
          stopLoss: reclaimEvent.deviationCandle.low * (1 - context.config.stopBufferPct),
          entryOrders: buildRangeEntryOrders("long", range.low, upperEntry, context.config.ladderLevels),
          exitOrders: buildRangeExitOrders("long", exitStart, exitEnd, context.config.ladderLevels),
          range,
          triggerCandle: signalCandle,
          deviationCandle: reclaimEvent.deviationCandle,
          reason:
            "Original manual range logic: a 4h close deviated below the range and a later closed 4h candle reclaimed back inside it.",
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
        `${context.symbol}: manual v1 short reclaim confirmed inside range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}.`,
      ],
      signal: {
        strategyId: this.id,
        symbol: context.symbol,
        side: "short",
        entryReferencePrice: signalCandle.close,
        stopLoss: reclaimEvent.deviationCandle.high * (1 + context.config.stopBufferPct),
        entryOrders: buildRangeEntryOrders("short", lowerEntry, range.high, context.config.ladderLevels),
        exitOrders: buildRangeExitOrders("short", exitStart, exitEnd, context.config.ladderLevels),
        range,
        triggerCandle: signalCandle,
        deviationCandle: reclaimEvent.deviationCandle,
        reason:
          "Original manual range logic: a 4h close deviated above the range and a later closed 4h candle reclaimed back inside it.",
        generatedAt: signalCandle.closeTime,
        expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
        positionSizeUsd: context.config.positionSizeUsd,
      },
    };
  }
}
