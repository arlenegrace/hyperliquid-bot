import type { TradingStrategy } from "../src/types.js";
import { AnchoredRangeLadderStrategy } from "./anchoredRangeLadder.js";
import { ManualRangeTradingStrategy } from "./manualRangeTrading.js";
import { PivotClusterMeanReversionStrategy } from "./pivotClusterMeanReversion.js";

export function createAllStrategies(): TradingStrategy[] {
  return [
    new ManualRangeTradingStrategy(),
    new AnchoredRangeLadderStrategy(),
    new PivotClusterMeanReversionStrategy(),
  ];
}

export function createStrategies(): TradingStrategy[] {
  return [new ManualRangeTradingStrategy()];
}
