import assert from "node:assert/strict";
import test from "node:test";

import type {
  HyperliquidCancelOrderRequest,
  HyperliquidCancelOrderResult,
  HyperliquidOrderPlacementResult,
  HyperliquidPlaceOrderSpec,
} from "../clients/hyperliquidExchange.js";
import type { BotConfig, BrokerPosition } from "../types.js";
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

function createBrokerHarness(options: {
  cancelImpl?: (requests: HyperliquidCancelOrderRequest[]) => Promise<HyperliquidCancelOrderResult[]>;
  placeImpl?: (specs: HyperliquidPlaceOrderSpec[]) => Promise<HyperliquidOrderPlacementResult[]>;
} = {}) {
  const cancelCalls: HyperliquidCancelOrderRequest[][] = [];
  const placementCalls: HyperliquidPlaceOrderSpec[][] = [];
  const broker = new HyperliquidLiveBroker(createConfig(), "https://api.hyperliquid.xyz") as any;

  broker.gateway = {
    getAssetInfo: () => ({
      symbol: "BTC",
      assetId: 0,
      szDecimals: 3,
      maxLeverage: 50,
    }),
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
