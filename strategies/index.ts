import type { ActiveStrategyId, TradingStrategy } from "../src/types.js";
import { ManualRangeTradingStrategy } from "./manualRangeTrading.js";
import { ManualRangeTradingV1Strategy } from "./manualRangeTradingV1.js";
import { ManualRangeTradingV2Strategy } from "./manualRangeTradingV2.js";
import { ManualRangeTradingV3Strategy } from "./manualRangeTradingV3.js";

export function createAllStrategies(): TradingStrategy[] {
  return [
    new ManualRangeTradingStrategy(),
    new ManualRangeTradingV1Strategy(),
    new ManualRangeTradingV2Strategy(),
    new ManualRangeTradingV3Strategy(),
  ];
}

export function createStrategies(activeStrategyId: ActiveStrategyId): TradingStrategy[] {
  switch (activeStrategyId) {
    case "manual-range-trading-v1":
      return [new ManualRangeTradingV1Strategy()];
    case "manual-range-trading-v2":
      return [new ManualRangeTradingV2Strategy()];
    case "manual-range-trading-v3":
      return [new ManualRangeTradingV3Strategy()];
    default: {
      const unsupportedStrategyId: never = activeStrategyId;
      throw new Error(`Unsupported active strategy id: ${unsupportedStrategyId}`);
    }
  }
}
