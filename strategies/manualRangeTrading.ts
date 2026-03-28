import { buildManualRangeSnapshot } from "../src/manualRanges.js";
import { sumPositionStopRiskUsd } from "../src/risk.js";
import type {
  Candle,
  LadderLevelPlan,
  ManualRangeState,
  PositionCancellationRequest,
  TradeSide,
  StrategyContext,
  StrategyResult,
  TradingStrategy,
} from "../src/types.js";
import { buildRangeExitOrders } from "./ladderUtils.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const INITIAL_ENTRY_PCT = 0.1;
const EDGE_ENTRY_PCTS = [0.1, 0.01] as const;
const EDGE_RISK_FRACTIONS = [0.4, 0.6] as const;
const STOP_DISTANCE_VETO_PCT = 0.5;
const STOP_DISTANCE_VETO_LABEL = `${(STOP_DISTANCE_VETO_PCT * 100).toFixed(0)}%`;

interface ManualReclaimEvent {
  side: TradeSide;
  deviationCandle: Candle;
  reclaimCandle: Candle;
}

function closeInsideRange(candle: Candle, low: number, high: number): boolean {
  return candle.close >= low && candle.close <= high;
}

function buildInitialEntryOrders(
  side: TradeSide,
  entryPrice: number,
  immediateFill: boolean,
): LadderLevelPlan[] {
  return [
    {
      label: immediateFill ? "Initial Entry" : "Initial Limit Entry",
      price: entryPrice,
      riskFraction: 1,
    },
  ];
}

function buildEdgeEntryOrders(side: TradeSide, rangeLow: number, rangeHigh: number): LadderLevelPlan[] {
  const width = rangeHigh - rangeLow;
  const [firstPrice, secondPrice] =
    side === "long"
      ? [rangeLow + width * EDGE_ENTRY_PCTS[0], rangeLow + width * EDGE_ENTRY_PCTS[1]]
      : [rangeHigh - width * EDGE_ENTRY_PCTS[0], rangeHigh - width * EDGE_ENTRY_PCTS[1]];

  return [
    {
      label: "Edge Entry 1",
      price: firstPrice,
      riskFraction: EDGE_RISK_FRACTIONS[0],
    },
    {
      label: "Edge Entry 2",
      price: secondPrice,
      riskFraction: EDGE_RISK_FRACTIONS[1],
    },
  ];
}

function calculateStopLoss(side: TradeSide, state: ManualRangeState): number | undefined {
  return side === "long" ? state.lowestLowSinceValidFrom : state.highestHighSinceValidFrom;
}

function stopLossTooWide(side: TradeSide, stopLoss: number, rangeLow: number, rangeHigh: number): boolean {
  const rangeWidth = rangeHigh - rangeLow;
  if (side === "long") {
    return rangeLow - stopLoss > rangeWidth * STOP_DISTANCE_VETO_PCT;
  }

  return stopLoss - rangeHigh > rangeWidth * STOP_DISTANCE_VETO_PCT;
}

function isWithinInitialBoundary(side: TradeSide, closePrice: number, rangeLow: number, rangeHigh: number): boolean {
  const width = rangeHigh - rangeLow;
  const threshold = width * INITIAL_ENTRY_PCT;

  if (side === "long") {
    return closePrice <= rangeLow + threshold;
  }

  return closePrice >= rangeHigh - threshold;
}

function initialEntryPrice(side: TradeSide, rangeLow: number, rangeHigh: number): number {
  const width = rangeHigh - rangeLow;
  return side === "long" ? rangeLow + width * INITIAL_ENTRY_PCT : rangeHigh - width * INITIAL_ENTRY_PCT;
}

function findManualReclaimForSide(
  side: TradeSide,
  candles: Candle[],
  rangeLow: number,
  rangeHigh: number,
  lastConsumedReclaimTime?: number,
): ManualReclaimEvent | undefined {
  const latestCandle = candles.at(-1);
  if (!latestCandle || !closeInsideRange(latestCandle, rangeLow, rangeHigh)) {
    return undefined;
  }

  if (lastConsumedReclaimTime !== undefined && latestCandle.closeTime <= lastConsumedReclaimTime) {
    return undefined;
  }

  const latestIsSelfReclaim =
    side === "long" ? latestCandle.low < rangeLow : latestCandle.high > rangeHigh;
  if (latestIsSelfReclaim) {
    return {
      side,
      deviationCandle: latestCandle,
      reclaimCandle: latestCandle,
    };
  }

  for (let index = candles.length - 2; index >= 0; index -= 1) {
    const candidate = candles[index];
    if (!candidate) {
      continue;
    }

    const deviated = side === "long" ? candidate.low < rangeLow : candidate.high > rangeHigh;
    if (!deviated) {
      continue;
    }

    if (lastConsumedReclaimTime !== undefined && candidate.closeTime <= lastConsumedReclaimTime) {
      break;
    }

    const priorReclaim = candles
      .slice(index + 1, candles.length - 1)
      .some((candle) => closeInsideRange(candle, rangeLow, rangeHigh));

    if (!priorReclaim) {
      return {
        side,
        deviationCandle: candidate,
        reclaimCandle: latestCandle,
      };
    }
  }

  return undefined;
}

function findLatestManualReclaimEvent(
  candles: Candle[],
  state: ManualRangeState,
  rangeLow: number,
  rangeHigh: number,
): ManualReclaimEvent | undefined {
  const latestCandle = candles.at(-1);
  if (!latestCandle || !closeInsideRange(latestCandle, rangeLow, rangeHigh)) {
    return undefined;
  }

  const longReclaim = findManualReclaimForSide("long", candles, rangeLow, rangeHigh, state.lastLongReclaimTime);
  const shortReclaim = findManualReclaimForSide("short", candles, rangeLow, rangeHigh, state.lastShortReclaimTime);

  if (longReclaim && shortReclaim) {
    const latestTouchedBothSides = latestCandle.low < rangeLow && latestCandle.high > rangeHigh;
    if (latestTouchedBothSides) {
      return undefined;
    }

    return longReclaim.deviationCandle.closeTime >= shortReclaim.deviationCandle.closeTime
      ? longReclaim
      : shortReclaim;
  }

  return longReclaim ?? shortReclaim;
}

export class ManualRangeTradingStrategy implements TradingStrategy {
  readonly id = "manual-range-trading";
  readonly description =
    "Uses manually supplied range highs and lows, tracks wick deviations and range-state transitions, and sizes every entry from stop-defined risk.";

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

    if (!context.manualRangeState) {
      return {
        notes: [`${context.symbol}: manual range exists but no persisted state was available for ${this.id}.`],
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
    const previousCandle = activeCandles.at(-2);
    const state = context.manualRangeState;
    const currentRiskUsd = sumPositionStopRiskUsd(context.openPositions);
    const maxRiskUsd = context.currentEquityUsd * context.config.manualRangeMaxRiskPct;
    const remainingRiskUsd = Math.max(0, maxRiskUsd - currentRiskUsd);
    const notes: string[] = [];
    const positionCancellations: PositionCancellationRequest[] = [];

    if (
      state.activeOrderPlan &&
      !context.openPositions.some(
        (position) =>
          position.status === "pending" &&
          position.setupKind === state.activeOrderPlan?.setupKind &&
          position.side === state.activeOrderPlan?.side,
      )
    ) {
      delete state.activeOrderPlan;
    }

    const pendingInitialPositions = context.openPositions.filter(
      (position) => position.status === "pending" && position.setupKind === "initial-reclaim",
    );
    for (const position of pendingInitialPositions) {
      const reachedMidRange =
        position.side === "long" ? signalCandle.close >= range.mid : signalCandle.close <= range.mid;
      if (!reachedMidRange) {
        continue;
      }

      positionCancellations.push({
        positionId: position.id,
        reason: "initial reclaim order cancelled at mid-range",
        note: `${context.symbol}: price reached the mid-range before the first reclaim order filled.`,
      });

      if (state.activeOrderPlan?.setupKind === "initial-reclaim" && state.activeOrderPlan.side === position.side) {
        delete state.activeOrderPlan;
      }
    }

    if (remainingRiskUsd <= 0) {
      notes.push(
        `${context.symbol}: skipped ${this.id} because current worst-case stop loss is already ${currentRiskUsd.toFixed(2)} USD against the ${maxRiskUsd.toFixed(2)} USD cap.`,
      );
      return {
        notes,
        ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
      };
    }

    const reclaimEvent = findLatestManualReclaimEvent(activeCandles, state, range.low, range.high);
    if (reclaimEvent) {
      const hasPendingSameSidePosition = context.openPositions.some(
        (position) => position.status === "pending" && position.side === reclaimEvent.side,
      );
      if (hasPendingSameSidePosition) {
        notes.push(
          `${context.symbol}: skipped ${reclaimEvent.side} reclaim because a same-side pending order plan is already active.`,
        );
        return {
          notes,
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
        };
      }

      const stopLoss = calculateStopLoss(reclaimEvent.side, state);
      if (stopLoss === undefined) {
        notes.push(`${context.symbol}: reclaim detected but stop-loss history is missing for ${reclaimEvent.side}.`);
      } else if (stopLossTooWide(reclaimEvent.side, stopLoss, range.low, range.high)) {
        notes.push(
          `${context.symbol}: skipped ${reclaimEvent.side} reclaim because stop ${stopLoss.toFixed(2)} exceeds the ${STOP_DISTANCE_VETO_LABEL} max stop distance for range ${range.low.toFixed(2)} - ${range.high.toFixed(2)}.`,
        );
      } else {
        const immediateFill = isWithinInitialBoundary(reclaimEvent.side, signalCandle.close, range.low, range.high);
        const entryPrice = immediateFill
          ? signalCandle.close
          : initialEntryPrice(reclaimEvent.side, range.low, range.high);
        const exitStart =
          reclaimEvent.side === "long"
            ? range.low + range.width * context.config.ladderExitStartPct
            : range.high - range.width * context.config.ladderExitStartPct;
        const exitEnd =
          reclaimEvent.side === "long"
            ? range.low + range.width * context.config.ladderExitEndPct
            : range.high - range.width * context.config.ladderExitEndPct;

        if (reclaimEvent.side === "long") {
          state.lastLongReclaimTime = reclaimEvent.reclaimCandle.closeTime;
          state.edgeReentryEnabledLong = true;
        } else {
          state.lastShortReclaimTime = reclaimEvent.reclaimCandle.closeTime;
          state.edgeReentryEnabledShort = true;
        }

        if (!immediateFill) {
          state.activeOrderPlan = {
            side: reclaimEvent.side,
            setupKind: "initial-reclaim",
            armedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            entryPrices: [entryPrice],
            cancelAtMidRange: true,
          };
        } else if (
          state.activeOrderPlan?.setupKind === "initial-reclaim" &&
          state.activeOrderPlan.side === reclaimEvent.side
        ) {
          delete state.activeOrderPlan;
        }

        return {
          notes: [
            ...notes,
            `${context.symbol}: manual ${reclaimEvent.side} reclaim confirmed inside range ${range.low.toFixed(2)} - ${range.high.toFixed(2)} with ${(remainingRiskUsd).toFixed(2)} USD risk budget remaining.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: reclaimEvent.side,
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: remainingRiskUsd,
            entryOrders: buildInitialEntryOrders(reclaimEvent.side, entryPrice, immediateFill),
            exitOrders: buildRangeExitOrders(reclaimEvent.side, exitStart, exitEnd, context.config.ladderLevels),
            range,
            triggerCandle: signalCandle,
            deviationCandle: reclaimEvent.deviationCandle,
            reason:
              reclaimEvent.side === "long"
                ? "Manual range saw a downside wick deviation and then a 4h close back inside the range."
                : "Manual range saw an upside wick deviation and then a 4h close back inside the range.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "initial-reclaim",
            metadata: {
              immediateFill,
              remainingRiskUsd: Number(remainingRiskUsd.toFixed(2)),
            },
          },
        };
      }
    }

    const hasPendingLongPlan = context.openPositions.some(
      (position) => position.status === "pending" && position.side === "long",
    );
    const hasPendingShortPlan = context.openPositions.some(
      (position) => position.status === "pending" && position.side === "short",
    );

    const longEdgeTrigger =
      state.edgeReentryEnabledLong &&
      !hasPendingLongPlan &&
      previousCandle !== undefined &&
      previousCandle.close < range.mid &&
      signalCandle.close >= range.mid;
    if (longEdgeTrigger) {
      const stopLoss = calculateStopLoss("long", state);
      if (stopLoss === undefined) {
        notes.push(`${context.symbol}: long edge re-entry skipped because no downside stop reference exists yet.`);
      } else if (stopLossTooWide("long", stopLoss, range.low, range.high)) {
        notes.push(
          `${context.symbol}: long edge re-entry skipped because stop ${stopLoss.toFixed(2)} exceeds the ${STOP_DISTANCE_VETO_LABEL} max stop distance.`,
        );
      } else {
        state.activeOrderPlan = {
          side: "long",
          setupKind: "edge-reentry",
          armedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
          entryPrices: buildEdgeEntryOrders("long", range.low, range.high).map((order) => order.price),
          cancelAtMidRange: false,
        };

        return {
          notes: [
            ...notes,
            `${context.symbol}: armed long edge re-entry orders using the remaining ${remainingRiskUsd.toFixed(2)} USD stop-loss budget.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: "long",
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: remainingRiskUsd,
            entryOrders: buildEdgeEntryOrders("long", range.low, range.high),
            exitOrders: buildRangeExitOrders(
              "long",
              range.low + range.width * context.config.ladderExitStartPct,
              range.low + range.width * context.config.ladderExitEndPct,
              context.config.ladderLevels,
            ),
            range,
            triggerCandle: signalCandle,
            reason:
              "Price previously deviated below the manual range, then reclaimed, and later crossed back into the upper half of the range to arm pullback bids.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "edge-reentry",
            metadata: {
              remainingRiskUsd: Number(remainingRiskUsd.toFixed(2)),
              riskSplit: "2:3",
            },
          },
        };
      }
    }

    const shortEdgeTrigger =
      state.edgeReentryEnabledShort &&
      !hasPendingShortPlan &&
      previousCandle !== undefined &&
      previousCandle.close > range.mid &&
      signalCandle.close <= range.mid;
    if (shortEdgeTrigger) {
      const stopLoss = calculateStopLoss("short", state);
      if (stopLoss === undefined) {
        notes.push(`${context.symbol}: short edge re-entry skipped because no upside stop reference exists yet.`);
      } else if (stopLossTooWide("short", stopLoss, range.low, range.high)) {
        notes.push(
          `${context.symbol}: short edge re-entry skipped because stop ${stopLoss.toFixed(2)} exceeds the ${STOP_DISTANCE_VETO_LABEL} max stop distance.`,
        );
      } else {
        state.activeOrderPlan = {
          side: "short",
          setupKind: "edge-reentry",
          armedAt: signalCandle.closeTime,
          expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
          entryPrices: buildEdgeEntryOrders("short", range.low, range.high).map((order) => order.price),
          cancelAtMidRange: false,
        };

        return {
          notes: [
            ...notes,
            `${context.symbol}: armed short edge re-entry orders using the remaining ${remainingRiskUsd.toFixed(2)} USD stop-loss budget.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: "short",
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: remainingRiskUsd,
            entryOrders: buildEdgeEntryOrders("short", range.low, range.high),
            exitOrders: buildRangeExitOrders(
              "short",
              range.high - range.width * context.config.ladderExitStartPct,
              range.high - range.width * context.config.ladderExitEndPct,
              context.config.ladderLevels,
            ),
            range,
            triggerCandle: signalCandle,
            reason:
              "Price previously deviated above the manual range, then reclaimed, and later crossed back into the lower half of the range to arm pullback offers.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "edge-reentry",
            metadata: {
              remainingRiskUsd: Number(remainingRiskUsd.toFixed(2)),
              riskSplit: "2:3",
            },
          },
        };
      }
    }

    notes.push(
      `${context.symbol}: manual range ${range.low.toFixed(2)} - ${range.high.toFixed(2)} is active, but no fresh reclaim or edge re-entry setup exists on the newest closed candle.`,
    );

    return {
      notes,
      ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
    };
  }
}
