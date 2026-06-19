import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { formatPerpPriceForConsole } from "./consoleFormat.js";
import type {
  Candle,
  ManualRangeDefinition,
  ManualRangeOrderPlanState,
  ManualRangeState,
  RangeSnapshot,
} from "./types.js";

const manualRangeEntrySchema = z
  .object({
    symbol: z.string().min(1).transform((value) => value.trim().toUpperCase()),
    rangeLow: z.number().positive(),
    rangeHigh: z.number().positive(),
    validFromTime: z
      .union([z.string().datetime(), z.number().int().nonnegative()])
      .optional()
      .transform((value) => {
        if (value === undefined) {
          return undefined;
        }

        return typeof value === "number" ? value : Date.parse(value);
      }),
    notes: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.rangeHigh > value.rangeLow, {
    message: "rangeHigh must be greater than rangeLow.",
    path: ["rangeHigh"],
  });

const manualRangeFileSchema = z.object({
  ranges: z.array(manualRangeEntrySchema),
});

const manualRangeOrderPlanStateSchema = z.object({
  side: z.enum(["long", "short"]),
  setupKind: z.enum(["initial-reclaim", "edge-reentry"]),
  armedAt: z.number().int().nonnegative(),
  expiryTime: z.number().int().nonnegative(),
  entryPrices: z.array(z.number().positive()),
  cancelAtMidRange: z.boolean(),
});

const manualRangeStateSchema = z.object({
  symbol: z.string().min(1).transform((value) => value.trim().toUpperCase()),
  fingerprint: z.string().min(1),
  isInvalidated: z.boolean(),
  invalidatedAt: z.number().int().nonnegative().optional(),
  invalidationPrice: z.number().positive().optional(),
  invalidationReason: z.string().min(1).optional(),
  hasDeviatedBelow: z.boolean().default(false),
  hasDeviatedAbove: z.boolean().default(false),
  lowestLowSinceValidFrom: z.number().positive().optional(),
  highestHighSinceValidFrom: z.number().positive().optional(),
  lastTrackedCandleCloseTime: z.number().int().nonnegative().optional(),
  lastLongReclaimTime: z.number().int().nonnegative().optional(),
  lastShortReclaimTime: z.number().int().nonnegative().optional(),
  edgeReentryEnabledLong: z.boolean().default(false),
  edgeReentryEnabledShort: z.boolean().default(false),
  activeOrderPlan: manualRangeOrderPlanStateSchema.optional(),
});

const manualRangeStateFileSchema = z.object({
  states: z.array(manualRangeStateSchema),
});

export type ManualRangeMap = Record<string, ManualRangeDefinition>;

function resolveManualRangePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function cloneOrderPlan(plan: ManualRangeOrderPlanState | undefined): ManualRangeOrderPlanState | undefined {
  return plan
    ? {
        ...plan,
        entryPrices: [...plan.entryPrices],
      }
    : undefined;
}

function normalizeManualRangeState(state: ManualRangeState): ManualRangeState {
  return {
    symbol: state.symbol,
    fingerprint: state.fingerprint,
    isInvalidated: state.isInvalidated,
    hasDeviatedBelow: state.hasDeviatedBelow,
    hasDeviatedAbove: state.hasDeviatedAbove,
    edgeReentryEnabledLong: state.edgeReentryEnabledLong,
    edgeReentryEnabledShort: state.edgeReentryEnabledShort,
    ...(state.invalidatedAt !== undefined ? { invalidatedAt: state.invalidatedAt } : {}),
    ...(state.invalidationPrice !== undefined ? { invalidationPrice: state.invalidationPrice } : {}),
    ...(state.invalidationReason !== undefined ? { invalidationReason: state.invalidationReason } : {}),
    ...(state.lowestLowSinceValidFrom !== undefined
      ? { lowestLowSinceValidFrom: state.lowestLowSinceValidFrom }
      : {}),
    ...(state.highestHighSinceValidFrom !== undefined
      ? { highestHighSinceValidFrom: state.highestHighSinceValidFrom }
      : {}),
    ...(state.lastTrackedCandleCloseTime !== undefined
      ? { lastTrackedCandleCloseTime: state.lastTrackedCandleCloseTime }
      : {}),
    ...(state.lastLongReclaimTime !== undefined ? { lastLongReclaimTime: state.lastLongReclaimTime } : {}),
    ...(state.lastShortReclaimTime !== undefined ? { lastShortReclaimTime: state.lastShortReclaimTime } : {}),
    ...(state.activeOrderPlan ? { activeOrderPlan: cloneOrderPlan(state.activeOrderPlan)! } : {}),
  };
}

export async function loadManualRanges(filePath: string): Promise<ManualRangeMap> {
  const absolutePath = resolveManualRangePath(filePath);
  try {
    const rawFile = await readFile(absolutePath, "utf8");
    const parsedFile = manualRangeFileSchema.parse(JSON.parse(rawFile));

    return Object.fromEntries(
      parsedFile.ranges.map((range) => [
        range.symbol,
        {
          symbol: range.symbol,
          rangeLow: range.rangeLow,
          rangeHigh: range.rangeHigh,
          ...(range.validFromTime !== undefined ? { validFromTime: range.validFromTime } : {}),
          ...(range.notes !== undefined ? { notes: range.notes } : {}),
        },
      ]),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(`[manual-ranges] Range file ${absolutePath} not found. Using empty ranges.`);
      return {};
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[manual-ranges] Failed to parse range file ${absolutePath}: ${message}. Using empty ranges.`);
    return {};
  }
}

export function getManualRangeForSymbol(ranges: ManualRangeMap, symbol: string): ManualRangeDefinition | undefined {
  return ranges[symbol.toUpperCase()];
}

export function createManualRangeFingerprint(range: ManualRangeDefinition): string {
  return [
    range.symbol,
    range.rangeLow.toFixed(8),
    range.rangeHigh.toFixed(8),
    range.validFromTime ?? "none",
    range.notes ?? "",
  ].join("|");
}

export function getManualRangeMapFingerprint(ranges: ManualRangeMap): string {
  return Object.values(ranges)
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((range) => createManualRangeFingerprint(range))
    .join("||");
}

export function buildManualRangeSnapshot(
  range: ManualRangeDefinition,
  referenceTime: number,
  lookbackCandles: number,
): RangeSnapshot {
  const width = range.rangeHigh - range.rangeLow;
  const mid = range.rangeLow + width / 2;

  return {
    high: range.rangeHigh,
    low: range.rangeLow,
    mid,
    width,
    widthPct: width / mid,
    lookbackCandles,
    startTime: range.validFromTime ?? referenceTime,
    endTime: referenceTime,
    anchorHighTime: range.validFromTime ?? referenceTime,
    anchorLowTime: range.validFromTime ?? referenceTime,
    highTouchCount: 1,
    lowTouchCount: 1,
    source: "manual",
    confidenceScore: 1_000,
  };
}

export function getManualRangeInvalidationBounds(
  range: ManualRangeDefinition,
  extensionPctOfWidth: number,
): {
  lowerInvalidationPrice: number;
  upperInvalidationPrice: number;
} {
  const width = range.rangeHigh - range.rangeLow;
  const extension = width * extensionPctOfWidth;

  return {
    lowerInvalidationPrice: range.rangeLow - extension,
    upperInvalidationPrice: range.rangeHigh + extension,
  };
}

export function syncManualRangeState(
  currentState: ManualRangeState | undefined,
  range: ManualRangeDefinition,
): ManualRangeState {
  const fingerprint = createManualRangeFingerprint(range);

  if (!currentState || currentState.fingerprint !== fingerprint) {
    return {
      symbol: range.symbol,
      fingerprint,
      isInvalidated: false,
      hasDeviatedBelow: false,
      hasDeviatedAbove: false,
      edgeReentryEnabledLong: false,
      edgeReentryEnabledShort: false,
    };
  }

  return normalizeManualRangeState(currentState);
}

export function refreshManualRangeTrackingFromCandles(
  state: ManualRangeState,
  range: ManualRangeDefinition,
  candles: Candle[],
): ManualRangeState {
  const validFromTime = range.validFromTime ?? 0;
  const activeCandles = candles.filter((candle) => candle.closeTime >= validFromTime);
  const nextState = normalizeManualRangeState(state);
  nextState.hasDeviatedBelow = false;
  nextState.hasDeviatedAbove = false;
  delete nextState.lowestLowSinceValidFrom;
  delete nextState.highestHighSinceValidFrom;
  const latestTrackedCloseTime = activeCandles.at(-1)?.closeTime;
  if (latestTrackedCloseTime !== undefined) {
    nextState.lastTrackedCandleCloseTime = latestTrackedCloseTime;
  } else {
    delete nextState.lastTrackedCandleCloseTime;
  }
  if (!nextState.activeOrderPlan) {
    delete nextState.activeOrderPlan;
  }

  for (const candle of activeCandles) {
    nextState.lowestLowSinceValidFrom =
      nextState.lowestLowSinceValidFrom === undefined
        ? candle.low
        : Math.min(nextState.lowestLowSinceValidFrom, candle.low);
    nextState.highestHighSinceValidFrom =
      nextState.highestHighSinceValidFrom === undefined
        ? candle.high
        : Math.max(nextState.highestHighSinceValidFrom, candle.high);

    if (candle.low < range.rangeLow) {
      nextState.hasDeviatedBelow = true;
    }

    if (candle.high > range.rangeHigh) {
      nextState.hasDeviatedAbove = true;
    }
  }

  return nextState;
}

export async function loadManualRangeStates(filePath: string): Promise<Map<string, ManualRangeState>> {
  const absolutePath = resolveManualRangePath(filePath);

  try {
    const rawFile = await readFile(absolutePath, "utf8");
    const parsedFile = manualRangeStateFileSchema.parse(JSON.parse(rawFile));
    return new Map(
      parsedFile.states.map((state) => [state.symbol, normalizeManualRangeState(state as ManualRangeState)]),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Map();
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[manual-ranges] Failed to parse range state file ${absolutePath}: ${message}. Using empty state.`);
    return new Map();
  }
}

export async function saveManualRangeStates(
  filePath: string,
  states: Map<string, ManualRangeState>,
): Promise<void> {
  const absolutePath = resolveManualRangePath(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const payload = {
    states: [...states.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)),
  };
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function applyManualRangeInvalidation(
  state: ManualRangeState,
  range: ManualRangeDefinition,
  candle: Candle,
  extensionPctOfWidth: number,
): { state: ManualRangeState; invalidatedNow: boolean } {
  if (state.isInvalidated) {
    return { state, invalidatedNow: false };
  }

  const { lowerInvalidationPrice, upperInvalidationPrice } = getManualRangeInvalidationBounds(range, extensionPctOfWidth);

  if (candle.close > upperInvalidationPrice) {
    return {
      state: {
        ...state,
        isInvalidated: true,
        invalidatedAt: candle.closeTime,
        invalidationPrice: candle.close,
        invalidationReason: `Close ${formatPerpPriceForConsole(candle.close)} exceeded manual range invalidation level ${formatPerpPriceForConsole(upperInvalidationPrice)} above ${formatPerpPriceForConsole(range.rangeHigh)}.`,
      },
      invalidatedNow: true,
    };
  }

  if (candle.close < lowerInvalidationPrice) {
    return {
      state: {
        ...state,
        isInvalidated: true,
        invalidatedAt: candle.closeTime,
        invalidationPrice: candle.close,
        invalidationReason: `Close ${formatPerpPriceForConsole(candle.close)} exceeded manual range invalidation level ${formatPerpPriceForConsole(lowerInvalidationPrice)} below ${formatPerpPriceForConsole(range.rangeLow)}.`,
      },
      invalidatedNow: true,
    };
  }

  return { state, invalidatedNow: false };
}
