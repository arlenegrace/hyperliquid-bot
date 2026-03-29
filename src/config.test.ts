import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

const LIVE_PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const LIVE_ACCOUNT_ADDRESS = "0x1111111111111111111111111111111111111111";

function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => void,
): void {
  const originalValues = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    originalValues.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig rejects live mode without credentials", () => {
  withEnv(
    {
      EXECUTION_MODE: "live",
      HL_PRIVATE_KEY: undefined,
      HL_ACCOUNT_ADDRESS: undefined,
    },
    () => {
      assert.throws(() => loadConfig(), /HL_PRIVATE_KEY must be set when EXECUTION_MODE=live/);
    },
  );
});

test("loadConfig parses live trading flags and limits", () => {
  withEnv(
    {
      EXECUTION_MODE: "live",
      ACTIVE_STRATEGY: "manual-range-trading-v1",
      HL_PRIVATE_KEY: LIVE_PRIVATE_KEY,
      HL_ACCOUNT_ADDRESS: LIVE_ACCOUNT_ADDRESS,
      POSITION_SIZE_USD: "20",
      LIVE_TRADING_ENABLED: "true",
      LIVE_DRY_RUN: "false",
      HL_USE_TESTNET: "true",
      LIVE_MARGIN_MODE: "isolated",
      LIVE_MAX_NOTIONAL_USD: "2500",
      LIVE_MAX_OPEN_POSITIONS: "7",
      LIVE_SLIPPAGE_BPS: "15",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.executionMode, "live");
      assert.equal(config.activeStrategyId, "manual-range-trading-v1");
      assert.equal(config.positionSizeUsd, 20);
      assert.equal(config.live.enabled, true);
      assert.equal(config.live.dryRun, false);
      assert.equal(config.live.useTestnet, true);
      assert.equal(config.live.marginMode, "isolated");
      assert.equal(config.live.maxNotionalUsd, 2_500);
      assert.equal(config.live.maxOpenPositions, 7);
      assert.equal(config.live.slippageBps, 15);
      assert.equal(config.live.accountAddress, LIVE_ACCOUNT_ADDRESS);
      assert.equal(config.live.privateKey, LIVE_PRIVATE_KEY);
    },
  );
});

test("loadConfig accepts max leverage and keeps cross margin by default", () => {
  withEnv(
    {
      EXECUTION_MODE: "live",
      HL_PRIVATE_KEY: LIVE_PRIVATE_KEY,
      HL_ACCOUNT_ADDRESS: LIVE_ACCOUNT_ADDRESS,
      LIVE_DEFAULT_LEVERAGE: "max",
      LIVE_MARGIN_MODE: undefined,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.activeStrategyId, "manual-range-trading-v2");
      assert.equal(config.live.defaultLeverage, "max");
      assert.equal(config.live.marginMode, "cross");
    },
  );
});
