import assert from "node:assert/strict";
import test from "node:test";

import { createStrategies } from "./index.js";

test("createStrategies returns manual-range-trading-v1 when configured", () => {
  const strategies = createStrategies("manual-range-trading-v1");
  assert.deepEqual(strategies.map((strategy) => strategy.id), ["manual-range-trading-v1"]);
});

test("createStrategies returns manual-range-trading-v2 when configured", () => {
  const strategies = createStrategies("manual-range-trading-v2");
  assert.deepEqual(strategies.map((strategy) => strategy.id), ["manual-range-trading-v2"]);
});

test("createStrategies returns manual-range-trading-v3 when configured", () => {
  const strategies = createStrategies("manual-range-trading-v3");
  assert.deepEqual(strategies.map((strategy) => strategy.id), ["manual-range-trading-v3"]);
});
