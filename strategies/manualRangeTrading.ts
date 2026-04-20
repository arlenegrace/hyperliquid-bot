import { formatPerpPriceForConsole, wrapOrange } from "../src/consoleFormat.js";
import { buildManualRangeSnapshot } from "../src/manualRanges.js";
import { calculateSignalRiskBudgetUsd, getNetPositionSnapshot, isFlipSignal, sumPositionStopRiskUsd } from "../src/risk.js";
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

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const INITIAL_ENTRY_PCT = 0.1;
const EDGE_ENTRY_PCTS = [0.1, 0.01] as const;
const EDGE_RISK_FRACTIONS = [0.4, 0.6] as const;
const MID_RANGE_EXIT_SIZE_FRACTION = 0.5;

function maxStopExtensionLabel(maxExtensionPct: number): string {
  const pct = maxExtensionPct * 100;
  const text = Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1).replace(/\.0$/, "");
  return `${text}%`;
}

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

function buildFlipEntryOrders(
  side: TradeSide,
  rangeLow: number,
  rangeHigh: number,
  firstEntryPriceOverride?: number,
): LadderLevelPlan[] {
  const edgeOrders = buildEdgeEntryOrders(side, rangeLow, rangeHigh);
  const firstOrder = edgeOrders[0]!;
  const secondOrder = edgeOrders[1]!;

  return [
    {
      ...firstOrder,
      label: firstEntryPriceOverride === undefined ? "Flip Entry 1" : "Flip Entry 1 (Immediate)",
      price: firstEntryPriceOverride ?? firstOrder.price,
    },
    {
      ...secondOrder,
      label: "Flip Entry 2",
    },
  ];
}

function buildCampaignExitOrders(side: TradeSide, rangeLow: number, rangeHigh: number): LadderLevelPlan[] {
  const width = rangeHigh - rangeLow;
  const midPrice = rangeLow + width * 0.5;
  const reversalTriggerPrice =
    side === "long" ? rangeHigh - width * EDGE_ENTRY_PCTS[0] : rangeLow + width * EDGE_ENTRY_PCTS[0];

  return [
    {
      label: "Take Profit 1",
      price: midPrice,
      sizeFraction: MID_RANGE_EXIT_SIZE_FRACTION,
    },
    {
      label: "Take Profit 2",
      price: reversalTriggerPrice,
      sizeFraction: 1 - MID_RANGE_EXIT_SIZE_FRACTION,
    },
  ];
}

function calculateStopLoss(side: TradeSide, state: ManualRangeState): number | undefined {
  return side === "long" ? state.lowestLowSinceValidFrom : state.highestHighSinceValidFrom;
}

function stopLossTooWide(
  side: TradeSide,
  stopLoss: number,
  rangeLow: number,
  rangeHigh: number,
  maxExtensionPct: number,
): boolean {
  const rangeWidth = rangeHigh - rangeLow;
  if (side === "long") {
    return rangeLow - stopLoss > rangeWidth * maxExtensionPct;
  }

  return stopLoss - rangeHigh > rangeWidth * maxExtensionPct;
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
    const netPositionBeforeEntry = getNetPositionSnapshot(context.openPositions);
    const notes: string[] = [];
    const positionCancellations: PositionCancellationRequest[] = [];

    if (
      state.activeOrderPlan &&
      !context.openPositions.some(
        (position) =>
          position.setupKind === state.activeOrderPlan?.setupKind &&
          position.side === state.activeOrderPlan?.side &&
          position.entryOrders.some((order) => order.status === "pending"),
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

    const reclaimEvent = findLatestManualReclaimEvent(activeCandles, state, range.low, range.high);
    if (reclaimEvent) {
      const hasPendingSameSidePosition = context.openPositions.some(
        (position) => position.side === reclaimEvent.side && position.entryOrders.some((order) => order.status === "pending"),
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
      } else if (
        stopLossTooWide(reclaimEvent.side, stopLoss, range.low, range.high, context.config.manualRangeMaxStopExtensionPct)
      ) {
        notes.push(
          `${context.symbol}: skipped ${reclaimEvent.side} reclaim because stop ${formatPerpPriceForConsole(stopLoss)} exceeds the ${maxStopExtensionLabel(context.config.manualRangeMaxStopExtensionPct)} max stop distance for range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)}.`,
        );
      } else {
        const flipSignal = isFlipSignal(reclaimEvent.side, context.openPositions);
        const signalRiskUsd = calculateSignalRiskBudgetUsd(reclaimEvent.side, context.openPositions, maxRiskUsd);
        if (signalRiskUsd <= 0) {
          notes.push(
            `${context.symbol}: skipped ${reclaimEvent.side} reclaim because current worst-case stop loss is already ${currentRiskUsd.toFixed(2)} USD against the ${maxRiskUsd.toFixed(2)} USD cap.`,
          );
          return {
            notes,
            ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          };
        }

        const immediateFill = isWithinInitialBoundary(reclaimEvent.side, signalCandle.close, range.low, range.high);
        const entryPrice = immediateFill
          ? signalCandle.close
          : initialEntryPrice(reclaimEvent.side, range.low, range.high);
        const entryOrders = flipSignal
          ? buildFlipEntryOrders(
              reclaimEvent.side,
              range.low,
              range.high,
              immediateFill ? signalCandle.close : undefined,
            )
          : buildInitialEntryOrders(reclaimEvent.side, entryPrice, immediateFill);
        const pendingEntryPrices = entryOrders
          .filter((order) => !immediateFill || order.price !== entryPrice)
          .map((order) => order.price);

        if (reclaimEvent.side === "long") {
          state.lastLongReclaimTime = reclaimEvent.reclaimCandle.closeTime;
          state.edgeReentryEnabledLong = true;
        } else {
          state.lastShortReclaimTime = reclaimEvent.reclaimCandle.closeTime;
          state.edgeReentryEnabledShort = true;
        }

        if (pendingEntryPrices.length > 0) {
          state.activeOrderPlan = {
            side: reclaimEvent.side,
            setupKind: "initial-reclaim",
            armedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            entryPrices: pendingEntryPrices,
            cancelAtMidRange: !flipSignal,
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
            flipSignal
              ? `${context.symbol}: manual ${reclaimEvent.side} reclaim confirmed inside range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} and will flatten the current ${netPositionBeforeEntry?.side ?? "opposite"} before opening new ${reclaimEvent.side} risk up to ${signalRiskUsd.toFixed(2)} USD.`
              : `${context.symbol}: manual ${reclaimEvent.side} reclaim confirmed inside range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} with ${signalRiskUsd.toFixed(2)} USD risk budget remaining.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: reclaimEvent.side,
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: signalRiskUsd,
            entryOrders,
            exitOrders: buildCampaignExitOrders(reclaimEvent.side, range.low, range.high),
            range,
            triggerCandle: signalCandle,
            deviationCandle: reclaimEvent.deviationCandle,
            reason:
              flipSignal
                ? reclaimEvent.side === "long"
                  ? "Manual range saw an upside campaign reach its reversal area, then a downside reclaim, so the next long fill should flatten the current short before reopening net long."
                  : "Manual range saw a downside campaign reach its reversal area, then an upside reclaim, so the next short fill should flatten the current long before reopening net short."
                : reclaimEvent.side === "long"
                  ? "Manual range saw a downside wick deviation and then a 4h close back inside the range."
                  : "Manual range saw an upside wick deviation and then a 4h close back inside the range.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "initial-reclaim",
            entryMode: flipSignal ? "flip" : "standard",
            ...(netPositionBeforeEntry ? { netPositionBeforeEntry } : {}),
            metadata: {
              immediateFill,
              riskBudgetUsd: Number(signalRiskUsd.toFixed(2)),
            },
          },
        };
      }
    }

    const hasPendingLongPlan = context.openPositions.some(
      (position) => position.side === "long" && position.entryOrders.some((order) => order.status === "pending"),
    );
    const hasPendingShortPlan = context.openPositions.some(
      (position) => position.side === "short" && position.entryOrders.some((order) => order.status === "pending"),
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
      } else if (
        stopLossTooWide("long", stopLoss, range.low, range.high, context.config.manualRangeMaxStopExtensionPct)
      ) {
        notes.push(
          `${context.symbol}: long edge re-entry skipped because stop ${formatPerpPriceForConsole(stopLoss)} exceeds the ${maxStopExtensionLabel(context.config.manualRangeMaxStopExtensionPct)} max stop distance.`,
        );
      } else {
        const flipSignal = isFlipSignal("long", context.openPositions);
        const signalRiskUsd = calculateSignalRiskBudgetUsd("long", context.openPositions, maxRiskUsd);
        if (signalRiskUsd <= 0) {
          notes.push(
            `${context.symbol}: long edge re-entry skipped because current worst-case stop loss is already ${currentRiskUsd.toFixed(2)} USD against the ${maxRiskUsd.toFixed(2)} USD cap.`,
          );
          return {
            notes,
            ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          };
        }

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
            flipSignal
              ? `${context.symbol}: armed long flip orders using up to ${signalRiskUsd.toFixed(2)} USD of new long risk after flattening the current short.`
              : `${context.symbol}: armed long edge re-entry orders using the remaining ${signalRiskUsd.toFixed(2)} USD stop-loss budget.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: "long",
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: signalRiskUsd,
            entryOrders: buildEdgeEntryOrders("long", range.low, range.high),
            exitOrders: buildCampaignExitOrders("long", range.low, range.high),
            range,
            triggerCandle: signalCandle,
            reason:
              flipSignal
                ? "Price rotated back into the lower half after an upside campaign, so the long ladder should flatten the current short before reopening net long."
                : "Price previously deviated below the manual range, then reclaimed, and later crossed back into the upper half of the range to arm pullback bids.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "edge-reentry",
            entryMode: flipSignal ? "flip" : "standard",
            ...(netPositionBeforeEntry ? { netPositionBeforeEntry } : {}),
            metadata: {
              riskBudgetUsd: Number(signalRiskUsd.toFixed(2)),
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
      } else if (
        stopLossTooWide("short", stopLoss, range.low, range.high, context.config.manualRangeMaxStopExtensionPct)
      ) {
        notes.push(
          `${context.symbol}: short edge re-entry skipped because stop ${formatPerpPriceForConsole(stopLoss)} exceeds the ${maxStopExtensionLabel(context.config.manualRangeMaxStopExtensionPct)} max stop distance.`,
        );
      } else {
        const flipSignal = isFlipSignal("short", context.openPositions);
        const signalRiskUsd = calculateSignalRiskBudgetUsd("short", context.openPositions, maxRiskUsd);
        if (signalRiskUsd <= 0) {
          notes.push(
            `${context.symbol}: short edge re-entry skipped because current worst-case stop loss is already ${currentRiskUsd.toFixed(2)} USD against the ${maxRiskUsd.toFixed(2)} USD cap.`,
          );
          return {
            notes,
            ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          };
        }

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
            flipSignal
              ? `${context.symbol}: armed short flip orders using up to ${signalRiskUsd.toFixed(2)} USD of new short risk after flattening the current long.`
              : `${context.symbol}: armed short edge re-entry orders using the remaining ${signalRiskUsd.toFixed(2)} USD stop-loss budget.`,
          ],
          ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
          signal: {
            strategyId: this.id,
            symbol: context.symbol,
            side: "short",
            entryReferencePrice: signalCandle.close,
            stopLoss,
            maxRiskUsd: signalRiskUsd,
            entryOrders: buildEdgeEntryOrders("short", range.low, range.high),
            exitOrders: buildCampaignExitOrders("short", range.low, range.high),
            range,
            triggerCandle: signalCandle,
            reason:
              flipSignal
                ? "Price rotated back into the upper half after a downside campaign, so the short ladder should flatten the current long before reopening net short."
                : "Price previously deviated above the manual range, then reclaimed, and later crossed back into the lower half of the range to arm pullback offers.",
            generatedAt: signalCandle.closeTime,
            expiryTime: signalCandle.closeTime + context.config.signalExpiryCandles * FOUR_HOURS_MS,
            setupKind: "edge-reentry",
            entryMode: flipSignal ? "flip" : "standard",
            ...(netPositionBeforeEntry ? { netPositionBeforeEntry } : {}),
            metadata: {
              riskBudgetUsd: Number(signalRiskUsd.toFixed(2)),
              riskSplit: "2:3",
            },
          },
        };
      }
    }

    notes.push(
      `${context.symbol}: manual range ${formatPerpPriceForConsole(range.low)} - ${formatPerpPriceForConsole(range.high)} is active, but no fresh reclaim or edge re-entry setup exists on the newest closed candle for ${wrapOrange(this.id)}.`,
    );

    return {
      notes,
      ...(positionCancellations.length > 0 ? { positionCancellations } : {}),
    };
  }
}
