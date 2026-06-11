import assert from "node:assert/strict";
import test from "node:test";

import type {
  HyperliquidCancelOrderRequest,
  HyperliquidCancelOrderResult,
  HyperliquidOrderPlacementResult,
  HyperliquidPlaceOrderSpec,
} from "../clients/hyperliquidExchange.js";
import type { BotConfig, BrokerPosition, StrategySignal } from "../types.js";
import { HyperliquidLiveBroker } from "./liveBroker.js";

function createConfig(): BotConfig {
  return {
    apiBaseUrl: "https://api.hyperliquid.xyz",
    interval: "4h",
    watchlist: ["BTC"],
    pollIntervalMs: 60_000,
    runtimeMode: "poll",
    websocket: {
      candleCloseGraceMs: 10_000,
      candleBatchDebounceMs: 5_000,
      marketDataStaleMs: 300_000,
      accountDataStaleMs: 300_000,
      safetyReconcileMs: 14_400_000,
      postWriteEventWaitMs: 2_000,
      protectiveOrdersDebounceMs: 0,
    },
    executionMode: "live",
    activeStrategyId: "manual-range-trading-v2",
    rangeLookbackCandles: 500,
    paperStartingBalanceUsd: 2_000,
    positionSizeUsd: 100,
    live: {
      enabled: true,
      dryRun: false,
      useTestnet: false,
      accountAddress: "0x1111111111111111111111111111111111111111",
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
      stateFile: ".live-broker-state.test.json",
      defaultLeverage: 3,
      marginMode: "cross",
      maxNotionalUsd: 1_000,
      maxOpenPositions: 3,
      slippageBps: 10,
      orderTimeoutMs: 10_000,
    },
    stopBufferPct: 0.001,
    reclaimLookbackCandles: 12,
    ladderLevels: 5,
    ladderEntryBandPct: 0.2,
    ladderExitStartPct: 0.5,
    ladderExitEndPct: 1,
    signalExpiryCandles: 18,
    backtestSymbols: ["BTC"],
    backtestLookbackCandles: 900,
    manualRangeFile: "manual-ranges.json",
    manualRangeStateFile: ".manual-range-state.json",
    manualRangeInvalidationExtendPct: 0.5,
    manualRangeMaxStopExtensionPct: 0.5,
    manualRangeMaxRiskPct: 0.05,
    backtestTradingFeeRate: 0,
    backtestSlippageRate: 0,
  };
}

function createOpenPosition(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    id: "position-1",
    symbol: "BTC",
    strategyId: "manual-range-trading-v2",
    side: "long",
    entryReferencePrice: 100,
    signalTime: 1,
    expiryTime: 10,
    stopLoss: 95,
    intendedSizeUnits: 2,
    filledSizeUnits: 2,
    averageEntryPrice: 100,
    remainingSizeUnits: 2,
    entryOrders: [],
    exitOrders: [],
    realizedPnlUsd: 0,
    status: "open",
    ...overrides,
  };
}

function createSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  const triggerCandle = {
    openTime: 1,
    closeTime: 2,
    symbol: "BTC",
    interval: "4h" as const,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 1,
    trades: 1,
  };

  return {
    strategyId: "manual-range-trading-v2",
    symbol: "BTC",
    side: "long",
    entryReferencePrice: 100,
    stopLoss: 90,
    entryOrders: [
      { label: "entry 1", price: 100, riskFraction: 0.5 },
      { label: "entry 2", price: 110, riskFraction: 0.5 },
    ],
    exitOrders: [
      { label: "tp 1", price: 120, sizeFraction: 0.5 },
      { label: "tp 2", price: 130, sizeFraction: 0.5 },
    ],
    range: {
      high: 130,
      low: 90,
      mid: 110,
      width: 40,
      widthPct: 0.4,
      lookbackCandles: 10,
      startTime: 0,
      endTime: 2,
      anchorHighTime: 1,
      anchorLowTime: 1,
      highTouchCount: 1,
      lowTouchCount: 1,
      source: "manual",
      confidenceScore: 1,
    },
    triggerCandle,
    reason: "test",
    generatedAt: 2,
    expiryTime: 10,
    maxRiskUsd: 20,
    ...overrides,
  };
}

function createBrokerHarness(options: {
  cancelImpl?: (requests: HyperliquidCancelOrderRequest[]) => Promise<HyperliquidCancelOrderResult[]>;
  placeImpl?: (specs: HyperliquidPlaceOrderSpec[]) => Promise<HyperliquidOrderPlacementResult[]>;
} = {}) {
  const cancelCalls: HyperliquidCancelOrderRequest[][] = [];
  const placementCalls: HyperliquidPlaceOrderSpec[][] = [];
  const broker = new HyperliquidLiveBroker(createConfig(), "https://api.hyperliquid.xyz") as any;

  broker.gateway = {
    initialize: async () => {},
    validateAccountAddress: () => createConfig().live.accountAddress,
    getAssetInfo: () => ({
      symbol: "BTC",
      assetId: 0,
      szDecimals: 3,
      maxLeverage: 50,
    }),
    ensureLeverage: async () => 3,
    cancelOrders: async (requests: HyperliquidCancelOrderRequest[]) => {
      cancelCalls.push(requests.map((request) => ({ ...request })));
      if (options.cancelImpl) {
        return options.cancelImpl(requests);
      }

      return requests.map((request) => ({
        ...request,
        status: "success" as const,
      }));
    },
    placeOrders: async (specs: HyperliquidPlaceOrderSpec[]) => {
      placementCalls.push(specs.map((spec) => ({ ...spec })));
      if (options.placeImpl) {
        return options.placeImpl(specs);
      }

      return specs.map((spec) => ({
        symbol: spec.symbol,
        ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
        status: spec.trigger ? ("waitingForTrigger" as const) : ("resting" as const),
      }));
    },
  };
  broker.initialized = true;
  broker.accountAddress = createConfig().live.accountAddress;
  broker.lastAccountStreamEventAt = Date.now();
  broker.saveState = async () => {};

  return {
    broker,
    cancelCalls,
    placementCalls,
  };
}

test("live broker replaces a resized stop with a fresh client order id", async () => {
  const oldStopClientOrderId = "0x11111111111111111111111111111111" as const;
  const { broker, cancelCalls, placementCalls } = createBrokerHarness();
  const position = createOpenPosition({
    stopOrder: {
      price: 95,
      sizeUnits: 1,
      status: "pending",
      clientOrderId: oldStopClientOrderId,
      exchangeOrderId: 123,
    },
  });

  broker.openExchangeOrderIds = new Set([oldStopClientOrderId]);
  broker.openExchangeOrderOids = new Set([123]);

  const logs = await broker.ensureProtectiveOrdersForPosition(position);

  assert.equal(cancelCalls.length, 1);
  assert.deepEqual(cancelCalls[0], [
    {
      symbol: "BTC",
      orderId: 123,
      clientOrderId: oldStopClientOrderId,
    },
  ]);
  assert.equal(placementCalls.length, 1);
  assert.equal(placementCalls[0]?.length, 1);

  const replacementStop = placementCalls[0]![0]!;
  assert.equal(replacementStop.sizeUnits, 2);
  assert.equal(replacementStop.reduceOnly, true);
  assert.equal(replacementStop.trigger?.tpsl, "sl");
  assert.notEqual(replacementStop.clientOrderId, oldStopClientOrderId);
  assert.equal(position.stopOrder?.clientOrderId, replacementStop.clientOrderId);
  assert.equal(position.stopOrder?.sizeUnits, 2);
  assert.match(logs.join("\n"), /cancelled 1 exchange order/);
});

test("live broker skips stop replacement when stop already covers intended size after a partial fill", async () => {
  const stopClientOrderId = "0x33333333333333333333333333333333" as const;
  const { broker, cancelCalls, placementCalls } = createBrokerHarness();
  const position = createOpenPosition({
    intendedSizeUnits: 2,
    filledSizeUnits: 1,
    remainingSizeUnits: 1,
    stopOrder: {
      price: 95,
      sizeUnits: 2,
      status: "pending",
      clientOrderId: stopClientOrderId,
      exchangeOrderId: 789,
    },
  });

  broker.openExchangeOrderIds = new Set([stopClientOrderId]);
  broker.openExchangeOrderOids = new Set([789]);

  await broker.ensureProtectiveOrdersForPosition(position);

  assert.equal(cancelCalls.length, 0);
  assert.equal(placementCalls.length, 0);
  assert.equal(position.stopOrder?.sizeUnits, 2);
});

test("live broker skips stop replacement when the existing stop cancel fails", async () => {
  const oldStopClientOrderId = "0x22222222222222222222222222222222" as const;
  const { broker, cancelCalls, placementCalls } = createBrokerHarness({
    cancelImpl: async (requests) =>
      requests.map((request) => ({
        ...request,
        status: "error" as const,
        error: "order was not cancelled",
      })),
  });
  const position = createOpenPosition({
    stopOrder: {
      price: 95,
      sizeUnits: 1,
      status: "pending",
      clientOrderId: oldStopClientOrderId,
      exchangeOrderId: 456,
    },
  });

  broker.openExchangeOrderIds = new Set([oldStopClientOrderId]);
  broker.openExchangeOrderOids = new Set([456]);

  const logs = await broker.ensureProtectiveOrdersForPosition(position);

  assert.equal(cancelCalls.length, 1);
  assert.equal(placementCalls.length, 0);
  assert.equal(position.stopOrder?.clientOrderId, oldStopClientOrderId);
  assert.equal(position.stopOrder?.sizeUnits, 1);
  assert.match(logs.join("\n"), /skipped stop-loss replacement/);
});

test("live broker skips a same-symbol entry when a local position is already active", async () => {
  const { broker, placementCalls } = createBrokerHarness();
  const position = createOpenPosition();
  broker.openPositions.set(position.id, position);

  const logs = await broker.openPosition(createSignal());

  assert.equal(placementCalls.length, 0);
  assert.match(logs.join("\n"), /active local position\(s\) already exist/);
});

test("live broker pauses protective order management for duplicate active symbol positions", async () => {
  const { broker, cancelCalls, placementCalls } = createBrokerHarness();
  const firstPosition = createOpenPosition({ id: "position-1" });
  const secondPosition = createOpenPosition({ id: "position-2" });
  broker.openPositions.set(firstPosition.id, firstPosition);
  broker.openPositions.set(secondPosition.id, secondPosition);

  const logs = await broker.runEnsureProtectiveOrders();

  assert.equal(cancelCalls.length, 0);
  assert.equal(placementCalls.length, 0);
  assert.match(logs.join("\n"), /multiple active local positions exist/);
});

test("live broker keeps accepted entry legs when another ladder leg is rejected", async () => {
  const { broker, placementCalls } = createBrokerHarness({
    placeImpl: async (specs) =>
      specs.map((spec, index) =>
        index === 0
          ? {
              symbol: spec.symbol,
              ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
              orderId: 1000,
              status: "resting" as const,
            }
          : {
              symbol: spec.symbol,
              ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
              status: "error" as const,
              error: "Insufficient margin",
            },
      ),
  });

  const logs = await broker.openPosition(createSignal());
  const positions = [...broker.openPositions.values()] as BrokerPosition[];

  assert.equal(placementCalls.length, 1);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.entryOrders[0]!.status, "pending");
  assert.equal(positions[0]!.entryOrders[1]!.status, "cancelled");
  assert.equal(positions[0]!.intendedSizeUnits, positions[0]!.entryOrders[0]!.sizeUnits);
  assert.equal(positions[0]!.exitOrders[0]!.sizeUnits, positions[0]!.intendedSizeUnits * 0.5);
  assert.match(logs.join("\n"), /was rejected by Hyperliquid: Insufficient margin/);
});
