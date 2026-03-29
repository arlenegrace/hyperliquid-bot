import type { TradingStrategy } from "../src/types.js";
import { AnchoredRangeLadderStrategy } from "./anchoredRangeLadder.js";
import { ManualRangeTradingStrategy } from "./manualRangeTrading.js";
import { ManualRangeTradingV1Strategy } from "./manualRangeTradingV1.js";
import { ManualRangeTradingV2Strategy } from "./manualRangeTradingV2.js";
import { PivotClusterMeanReversionStrategy } from "./pivotClusterMeanReversion.js";

export function createAllStrategies(): TradingStrategy[] {
  return [
    new ManualRangeTradingStrategy(),
    new ManualRangeTradingV1Strategy(),
    new ManualRangeTradingV2Strategy(),
    new AnchoredRangeLadderStrategy(),
    new PivotClusterMeanReversionStrategy(),
  ];
}

export function createStrategies(): TradingStrategy[] {
  return [new ManualRangeTradingV2Strategy()];
}
