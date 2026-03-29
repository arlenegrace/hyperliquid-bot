import type { BotConfig } from "../types.js";
import type { Broker } from "./broker.js";
import { HyperliquidLiveBroker } from "./liveBroker.js";
import { PaperBroker } from "./paperBroker.js";

export function createBroker(config: BotConfig): Broker {
  return config.executionMode === "live"
    ? new HyperliquidLiveBroker(config, config.apiBaseUrl)
    : new PaperBroker(config.paperStartingBalanceUsd, config.paperPositionSizeUsd);
}
