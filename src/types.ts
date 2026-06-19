export type CandleInterval = "4h";
export type TradeSide = "long" | "short";
export type RangeSource = "manual";
export type OrderStatus = "pending" | "filled" | "cancelled";
export type ExecutionMode = "paper" | "live";
export type RuntimeMode = "websocket" | "poll";
export type MarginMode = "cross" | "isolated";
export type LeverageSetting = number | "max";
export type ActiveStrategyId =
  | "manual-range-trading-v1"
  | "manual-range-trading-v2"
  | "manual-range-trading-v3";
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

export interface ReclaimEvent {
  side: TradeSide;
  deviationCandle: Candle;
  reclaimCandle: Candle;
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

export interface LiveTradingConfig {
  enabled: boolean;
  dryRun: boolean;
  useTestnet: boolean;
  accountAddress?: `0x${string}`;
  privateKey?: `0x${string}`;
  stateFile: string;
  defaultLeverage: LeverageSetting;
  marginMode: MarginMode;
  maxNotionalUsd: number;
  maxOpenPositions: number;
  slippageBps: number;
  orderTimeoutMs: number;
}

export interface WebsocketRuntimeConfig {
  candleCloseGraceMs: number;
  candleBatchDebounceMs: number;
  marketDataStaleMs: number;
  accountDataStaleMs: number;
  safetyReconcileMs: number;
  postWriteEventWaitMs: number;
  protectiveOrdersDebounceMs: number;
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
  runtimeMode: RuntimeMode;
  websocket: WebsocketRuntimeConfig;
  executionMode: ExecutionMode;
  activeStrategyId: ActiveStrategyId;
  rangeLookbackCandles: number;
  paperStartingBalanceUsd: number;
  positionSizeUsd: number;
  live: LiveTradingConfig;
  stopBufferPct: number;
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
  /** Extension beyond range low/high as a fraction of range width (e.g. 0.5 = half-width buffer). */
  manualRangeInvalidationExtendPct: number;
  /** Max distance from range boundary to stop, as a fraction of range width (e.g. 0.25 = 25% of width beyond the edge). */
  manualRangeMaxStopExtensionPct: number;
  manualRangeMaxRiskPct: number;
  backtestTradingFeeRate: number;
  backtestSlippageRate: number;
}

export interface StrategyContext {
  symbol: string;
  candles: Candle[];
  config: BotConfig;
  hasOpenPosition: boolean;
  openPositions: BrokerPosition[];
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
  clientOrderId?: `0x${string}`;
  exchangeOrderId?: number;
  filledSizeUnits?: number;
  averageFillPrice?: number;
  feePaidUsd?: number;
  filledAt?: number;
}

export interface PositionExitOrder {
  label: string;
  price: number;
  sizeFraction: number;
  sizeUnits: number;
  status: OrderStatus;
  clientOrderId?: `0x${string}`;
  exchangeOrderId?: number;
  filledSizeUnits?: number;
  averageFillPrice?: number;
  feePaidUsd?: number;
  hitAt?: number;
}

export interface PositionStopOrder {
  price: number;
  sizeUnits: number;
  status: OrderStatus;
  clientOrderId?: `0x${string}`;
  exchangeOrderId?: number;
  filledSizeUnits?: number;
  averageFillPrice?: number;
  feePaidUsd?: number;
  filledAt?: number;
}

export interface BrokerPosition {
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
  stopOrder?: PositionStopOrder;
  setupKind?: ManualRangeSetupKind;
  entryMode?: StrategyEntryMode;
  netPositionBeforeEntry?: NetPositionSnapshot;
  metadata?: Record<string, SignalMetadataValue>;
}

export type PaperPosition = BrokerPosition;

export interface BrokerSnapshot {
  startingBalanceUsd: number;
  /** Closed-trade PnL from fills (fees included); excludes perp funding payments. */
  realizedPnlUsd: number;
  /**
   * Cumulative net USDC from perpetual funding (positive = received, negative = paid).
   * Live: from exchange `userFunding` history. Paper: always 0.
   */
  lifetimeFundingUsd: number;
  unrealizedPnlUsd: number;
  /**
   * Live: latest cumulative PnL from Hyperliquid `portfolio` (`allTime` `pnlHistory`), aligned with the UI.
   * Paper: `equityUsd - startingBalanceUsd` for the session.
   */
  allTimePnlUsd: number;
  equityUsd: number;
  maxDrawdownPct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeesUsd: number;
  wins: number;
  losses: number;
  openPositions: BrokerPosition[];
  closedPositions: BrokerPosition[];
  cancelledPositions: BrokerPosition[];
  apiActionsUsed?: number;
  apiActionsCap?: number;
}

export type PaperBrokerSnapshot = BrokerSnapshot;
