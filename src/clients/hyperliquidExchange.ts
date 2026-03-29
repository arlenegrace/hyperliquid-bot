import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { SymbolConverter, formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";

import type { LeverageSetting, LiveTradingConfig, MarginMode, TradeSide } from "../types.js";

export interface HyperliquidAssetInfo {
  symbol: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
}

export interface HyperliquidAccountPosition {
  symbol: string;
  side: TradeSide;
  sizeUnits: number;
  entryPrice?: number;
  unrealizedPnlUsd: number;
}

export interface HyperliquidAccountSnapshot {
  accountValueUsd: number;
  withdrawableUsd: number;
  positionsBySymbol: Map<string, HyperliquidAccountPosition>;
}

export interface HyperliquidOpenOrder {
  symbol: string;
  side: TradeSide;
  price: number;
  sizeUnits: number;
  reduceOnly: boolean;
  orderId: number;
  clientOrderId?: `0x${string}`;
  timestamp: number;
}

export interface HyperliquidFill {
  symbol: string;
  side: TradeSide;
  price: number;
  sizeUnits: number;
  feeUsd: number;
  closedPnlUsd: number;
  orderId: number;
  clientOrderId?: `0x${string}`;
  time: number;
  tradeId: number;
}

export interface HyperliquidPlaceOrderSpec {
  symbol: string;
  side: TradeSide;
  price: number;
  sizeUnits: number;
  reduceOnly: boolean;
  tif?: "Gtc" | "FrontendMarket";
  clientOrderId?: `0x${string}`;
  trigger?: {
    isMarket: boolean;
    triggerPx: number;
    tpsl: "tp" | "sl";
  };
}

export interface HyperliquidOrderPlacementResult {
  symbol: string;
  clientOrderId?: `0x${string}`;
  orderId?: number;
  status: "resting" | "filled" | "waitingForFill" | "waitingForTrigger";
  filledSizeUnits?: number;
  averageFillPrice?: number;
}

function parseNumber(value: string): number {
  return Number(value);
}

function normalizeTradeSide(side: "B" | "A"): TradeSide {
  return side === "B" ? "long" : "short";
}

function normalizeWalletAddress(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

function resolveLeverageSetting(leverageSetting: LeverageSetting, assetInfo: HyperliquidAssetInfo): number {
  if (leverageSetting === "max") {
    return assetInfo.maxLeverage;
  }

  if (leverageSetting > assetInfo.maxLeverage) {
    throw new Error(
      `${assetInfo.symbol} max leverage is ${assetInfo.maxLeverage}x, but LIVE_DEFAULT_LEVERAGE is ${leverageSetting}x.`,
    );
  }

  return leverageSetting;
}

export class HyperliquidExchangeGateway {
  private readonly transport: HttpTransport;
  private readonly infoClient: InfoClient;
  private readonly exchangeClient: ExchangeClient;
  private readonly walletAddress: `0x${string}`;
  private readonly leverageConfiguredSymbols = new Set<string>();
  private readonly assetInfoBySymbol = new Map<string, HyperliquidAssetInfo>();

  private symbolConverter?: SymbolConverter;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly liveConfig: LiveTradingConfig,
  ) {
    if (!liveConfig.privateKey) {
      throw new Error("Live trading requires HL_PRIVATE_KEY.");
    }

    this.transport = new HttpTransport({
      apiUrl: apiBaseUrl,
      isTestnet: liveConfig.useTestnet,
      timeout: liveConfig.orderTimeoutMs,
    });

    const wallet = privateKeyToAccount(liveConfig.privateKey);
    this.walletAddress = normalizeWalletAddress(wallet.address);
    this.infoClient = new InfoClient({ transport: this.transport });
    this.exchangeClient = new ExchangeClient({ transport: this.transport, wallet });
  }

  async initialize(): Promise<void> {
    this.symbolConverter = await SymbolConverter.create({ transport: this.transport });
    const meta = await this.infoClient.meta();

    for (const asset of meta.universe) {
      const assetId = this.symbolConverter.getAssetId(asset.name);
      if (assetId === undefined) {
        continue;
      }

      this.assetInfoBySymbol.set(asset.name.toUpperCase(), {
        symbol: asset.name.toUpperCase(),
        assetId,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
      });
    }
  }

  getWalletAddress(): `0x${string}` {
    return this.walletAddress;
  }

  validateAccountAddress(configuredAddress?: `0x${string}`): `0x${string}` {
    const normalizedConfiguredAddress = configuredAddress ? normalizeWalletAddress(configuredAddress) : undefined;
    if (!normalizedConfiguredAddress) {
      return this.walletAddress;
    }

    if (normalizedConfiguredAddress !== this.walletAddress) {
      throw new Error(
        `Configured HL_ACCOUNT_ADDRESS ${configuredAddress} does not match the private key address ${this.walletAddress}.`,
      );
    }

    return normalizedConfiguredAddress;
  }

  getAssetInfo(symbol: string): HyperliquidAssetInfo {
    const assetInfo = this.assetInfoBySymbol.get(symbol.toUpperCase());
    if (!assetInfo) {
      throw new Error(`No Hyperliquid perpetual metadata is loaded for ${symbol}.`);
    }

    return assetInfo;
  }

  async ensureLeverage(symbol: string, leverageSetting: LeverageSetting, marginMode: MarginMode): Promise<number> {
    const normalizedSymbol = symbol.toUpperCase();
    if (this.leverageConfiguredSymbols.has(normalizedSymbol)) {
      return resolveLeverageSetting(leverageSetting, this.getAssetInfo(normalizedSymbol));
    }

    const assetInfo = this.getAssetInfo(normalizedSymbol);
    const leverage = resolveLeverageSetting(leverageSetting, assetInfo);

    await this.exchangeClient.updateLeverage({
      asset: assetInfo.assetId,
      isCross: marginMode === "cross",
      leverage,
    });

    this.leverageConfiguredSymbols.add(normalizedSymbol);
    return leverage;
  }

  async fetchAccountSnapshot(accountAddress: `0x${string}`): Promise<HyperliquidAccountSnapshot> {
    const state = await this.infoClient.clearinghouseState({ user: accountAddress });
    const positionsBySymbol = new Map<string, HyperliquidAccountPosition>();

    for (const assetPosition of state.assetPositions) {
      const sizeUnitsSigned = parseNumber(assetPosition.position.szi);
      if (sizeUnitsSigned === 0) {
        continue;
      }

      positionsBySymbol.set(assetPosition.position.coin.toUpperCase(), {
        symbol: assetPosition.position.coin.toUpperCase(),
        side: sizeUnitsSigned > 0 ? "long" : "short",
        sizeUnits: Math.abs(sizeUnitsSigned),
        entryPrice: parseNumber(assetPosition.position.entryPx),
        unrealizedPnlUsd: parseNumber(assetPosition.position.unrealizedPnl),
      });
    }

    return {
      accountValueUsd: parseNumber(state.marginSummary.accountValue),
      withdrawableUsd: parseNumber(state.withdrawable),
      positionsBySymbol,
    };
  }

  async fetchOpenOrders(accountAddress: `0x${string}`): Promise<HyperliquidOpenOrder[]> {
    const orders = await this.infoClient.openOrders({ user: accountAddress });
    return orders.map((order) => ({
      symbol: order.coin.toUpperCase(),
      side: normalizeTradeSide(order.side),
      price: parseNumber(order.limitPx),
      sizeUnits: parseNumber(order.sz),
      reduceOnly: order.reduceOnly ?? false,
      orderId: order.oid,
      ...(order.cloid ? { clientOrderId: order.cloid } : {}),
      timestamp: order.timestamp,
    }));
  }

  async fetchFillsSince(accountAddress: `0x${string}`, startTime: number, endTime?: number): Promise<HyperliquidFill[]> {
    const fills = await this.infoClient.userFillsByTime({
      user: accountAddress,
      startTime,
      ...(endTime !== undefined ? { endTime } : {}),
    });

    return fills.map((fill) => ({
      symbol: fill.coin.toUpperCase(),
      side: normalizeTradeSide(fill.side),
      price: parseNumber(fill.px),
      sizeUnits: parseNumber(fill.sz),
      feeUsd: Math.abs(parseNumber(fill.fee)),
      closedPnlUsd: parseNumber(fill.closedPnl),
      orderId: fill.oid,
      ...(fill.cloid ? { clientOrderId: fill.cloid } : {}),
      time: fill.time,
      tradeId: fill.tid,
    }));
  }

  async placeOrders(specs: HyperliquidPlaceOrderSpec[]): Promise<HyperliquidOrderPlacementResult[]> {
    const response = await this.exchangeClient.order({
      orders: specs.map((spec) => {
        const assetInfo = this.getAssetInfo(spec.symbol);
        return {
          a: assetInfo.assetId,
          b: spec.side === "long",
          p: formatPrice(spec.price, assetInfo.szDecimals),
          s: formatSize(spec.sizeUnits, assetInfo.szDecimals),
          r: spec.reduceOnly,
          t: spec.trigger
            ? {
                trigger: {
                  isMarket: spec.trigger.isMarket,
                  triggerPx: formatPrice(spec.trigger.triggerPx, assetInfo.szDecimals),
                  tpsl: spec.trigger.tpsl,
                },
              }
            : {
                limit: {
                  tif: spec.tif ?? "Gtc",
                },
              },
          ...(spec.clientOrderId ? { c: spec.clientOrderId } : {}),
        };
      }),
      grouping: "na",
    });

    return response.response.data.statuses.map((status, index) => {
      const spec = specs[index]!;
      if (status === "waitingForFill") {
        return {
          symbol: spec.symbol,
          ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
          status: "waitingForFill" as const,
        };
      }

      if (status === "waitingForTrigger") {
        return {
          symbol: spec.symbol,
          ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
          status: "waitingForTrigger" as const,
        };
      }

      if ("resting" in status) {
        return {
          symbol: spec.symbol,
          ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
          orderId: status.resting.oid,
          status: "resting" as const,
        };
      }

      return {
        symbol: spec.symbol,
        ...(spec.clientOrderId ? { clientOrderId: spec.clientOrderId } : {}),
        orderId: status.filled.oid,
        status: "filled" as const,
        filledSizeUnits: parseNumber(status.filled.totalSz),
        averageFillPrice: parseNumber(status.filled.avgPx),
      };
    });
  }

  async cancelOrdersByCloid(
    requests: Array<{ symbol: string; clientOrderId: `0x${string}` }>,
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }

    await this.exchangeClient.cancelByCloid({
      cancels: requests.map((request) => ({
        asset: this.getAssetInfo(request.symbol).assetId,
        cloid: request.clientOrderId,
      })),
    });
  }
}
