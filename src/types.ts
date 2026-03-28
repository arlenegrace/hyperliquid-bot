export type CandleInterval = "4h";
export type TradeSide = "long" | "short";
export type PivotType = "high" | "low";
export type RangeSource = "pivot-cluster" | "manual";
export type OrderStatus = "pending" | "filled" | "cancelled";
export type ManualRangeSetupKind = "initial-reclaim" | "edge-reentry";
export type StrategyEntryMode = "standard" | "flip";
export type SignalMetadataValue = string | number | boolean | undefined;

export interface Candle {
  openTime: number;
  closeTime: number;
  symbol: string;
  interval: CandleInterval;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface PivotPoint {
  type: PivotType;
  index: number;
  price: number;
  candle: Candle;
}

export interface PivotCluster {
  type: PivotType;
  level: number;
  tolerancePct: number;
  points: PivotPoint[];
  touchCount: number;
  firstTouchIndex: number;
  lastTouchIndex: number;
  firstTouchTime: number;
  lastTouchTime: number;
}

export interface RangeSnapshot {
  high: number;
  low: number;
  mid: number;
  width: number;
  widthPct: number;
  lookbackCandles: number;
  startTime: number;
  endTime: number;
  anchorHighTime: number;
  anchorLowTime: number;
  highTouchCount: number;
  lowTouchCount: number;
  source: RangeSource;
  confidenceScore: number;
}

export interface ManualRangeDefinition {
  symbol: string;
  rangeLow: number;
  rangeHigh: number;
  validFromTime?: number;
  notes?: string;
}

export interface ManualRangeState {
  symbol: string;
  fingerprint: string;
  isInvalidated: boolean;
  invalidatedAt?: number;
  invalidationPrice?: number;
  invalidationReason?: string;
  hasDeviatedBelow: boolean;
  hasDeviatedAbove: boolean;
  lowestLowSinceValidFrom?: number;
  highestHighSinceValidFrom?: number;
  lastTrackedCandleCloseTime?: number;
  lastLongReclaimTime?: number;
  lastShortReclaimTime?: number;
  edgeReentryEnabledLong: boolean;
  edgeReentryEnabledShort: boolean;
  activeOrderPlan?: ManualRangeOrderPlanState;
}

export interface LadderLevelPlan {
  label: string;
  price: number;
  sizeFraction?: number;
  riskFraction?: number;
}

export interface ManualRangeOrderPlanState {
  side: TradeSide;
  setupKind: ManualRangeSetupKind;
  armedAt: number;
  expiryTime: number;
  entryPrices: number[];
  cancelAtMidRange: boolean;
}

export interface PositionCancellationRequest {
  positionId: string;
  reason: string;
  note?: string;
}

export interface NetPositionSnapshot {
  side: TradeSide;
  sizeUnits: number;
}

export interface StrategySignal {
  strategyId: string;
  symbol: string;
  side: TradeSide;
  entryReferencePrice: number;
  stopLoss: number;
  entryOrders: LadderLevelPlan[];
  exitOrders: LadderLevelPlan[];
  range: RangeSnapshot;
  triggerCandle: Candle;
  deviationCandle?: Candle;
  reason: string;
  generatedAt: number;
  expiryTime: number;
  maxRiskUsd?: number;
  positionSizeUsd?: number;
  setupKind?: ManualRangeSetupKind;
  entryMode?: StrategyEntryMode;
  netPositionBeforeEntry?: NetPositionSnapshot;
  metadata?: Record<string, SignalMetadataValue>;
}

export interface StrategyResult {
  signal?: StrategySignal;
  notes: string[];
  positionCancellations?: PositionCancellationRequest[];
}

export interface BotConfig {
  apiBaseUrl: string;
  interval: CandleInterval;
  watchlist: string[];
  pollIntervalMs: number;
  rangeLookbackCandles: number;
  paperStartingBalanceUsd: number;
  paperPositionSizeUsd: number;
  stopBufferPct: number;
  pivotStrength: number;
  pivotClusterTolerancePct: number;
  rangeMinBoundaryTouches: number;
  rangeMinWidthPct: number;
  rangeMaxWidthPct: number;
  rangeMaxAgeCandles: number;
  rangeInsideCloseRatio: number;
  reclaimLookbackCandles: number;
  ladderLevels: number;
  ladderEntryBandPct: number;
  ladderExitStartPct: number;
  ladderExitEndPct: number;
  signalExpiryCandles: number;
  backtestSymbols: string[];
  backtestLookbackCandles: number;
  manualRangeFile: string;
  manualRangeStateFile: string;
  manualRangeMaxRiskPct: number;
  backtestTradingFeeRate: number;
  backtestSlippageRate: number;
}

export interface StrategyContext {
  symbol: string;
  candles: Candle[];
  config: BotConfig;
  hasOpenPosition: boolean;
  openPositions: PaperPosition[];
  currentEquityUsd: number;
  manualRange?: ManualRangeDefinition;
  manualRangeState?: ManualRangeState;
}

export interface TradingStrategy {
  id: string;
  description: string;
  evaluate(context: StrategyContext): StrategyResult;
}

export interface PositionEntryOrder {
  label: string;
  price: number;
  sizeFraction?: number;
  riskFraction?: number;
  riskBudgetUsd?: number;
  sizeUnits: number;
  status: OrderStatus;
  filledAt?: number;
}

export interface PositionExitOrder {
  label: string;
  price: number;
  sizeFraction: number;
  sizeUnits: number;
  status: OrderStatus;
  hitAt?: number;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  strategyId: string;
  side: TradeSide;
  entryReferencePrice: number;
  signalTime: number;
  expiryTime: number;
  stopLoss: number;
  intendedSizeUnits: number;
  filledSizeUnits: number;
  averageEntryPrice?: number;
  remainingSizeUnits: number;
  entryOrders: PositionEntryOrder[];
  exitOrders: PositionExitOrder[];
  realizedPnlUsd: number;
  status: "pending" | "open" | "closed" | "cancelled";
  closeReason?: string;
  closedAt?: number;
  setupKind?: ManualRangeSetupKind;
  entryMode?: StrategyEntryMode;
  netPositionBeforeEntry?: NetPositionSnapshot;
  metadata?: Record<string, SignalMetadataValue>;
}

export interface PaperBrokerSnapshot {
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  equityUsd: number;
  maxDrawdownPct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeesUsd: number;
  wins: number;
  losses: number;
  openPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  cancelledPositions: PaperPosition[];
}
