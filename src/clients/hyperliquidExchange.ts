import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type {
  SpotClearinghouseStateResponse,
  SpotMetaAndAssetCtxsResponse,
  UserAbstractionResponse,
} from "@nktkas/hyperliquid/api/info";
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

export interface HyperliquidCancelOrderRequest {
  symbol: string;
  orderId?: number;
  clientOrderId?: `0x${string}`;
}

export interface HyperliquidCancelOrderResult extends HyperliquidCancelOrderRequest {
  status: "success" | "error";
  error?: string;
}

function parseNumber(value: string): number {
  return Number(value);
}

/**
 * Unified / portfolio-margin accounts expose meaningful collateral in {@link SpotClearinghouseStateResponse};
 * perp-only `marginSummary.accountValue` is not meaningful for those modes (Hyperliquid docs).
 */
function accountValueUsesSpotClearinghouseLedger(mode: UserAbstractionResponse): boolean {
  return mode === "unifiedAccount" || mode === "portfolioMargin";
}

/**
 * Total USD value of spot (and escrowed spot) balances: stables at par; other coins via USDC/USDH-quoted pair mark.
 */
function sumUnifiedSpotPortfolioUsd(
  spotState: SpotClearinghouseStateResponse,
  [spotMeta, assetCtxs]: SpotMetaAndAssetCtxsResponse,
): number {
  const tokenByIndex = new Map(spotMeta.tokens.map((t) => [t.index, t]));

  const usdMarkByBaseTokenIndex = new Map<number, number>();
  for (let i = 0; i < spotMeta.universe.length && i < assetCtxs.length; i++) {
    const universe = spotMeta.universe[i];
    const ctx = assetCtxs[i];
    if (!universe?.tokens || universe.tokens.length < 2 || !ctx) {
      continue;
    }

    const quoteToken = tokenByIndex.get(universe.tokens[1]);
    if (!quoteToken || (quoteToken.name !== "USDC" && quoteToken.name !== "USDH")) {
      continue;
    }

    usdMarkByBaseTokenIndex.set(universe.tokens[0], parseNumber(ctx.markPx));
  }

  let sum = 0;
  for (const b of spotState.balances) {
    const amt = parseNumber(b.total);
    if (amt === 0) {
      continue;
    }

    if (b.coin === "USDC" || b.coin === "USDH") {
      sum += amt;
      continue;
    }

    const mark = usdMarkByBaseTokenIndex.get(b.token);
    if (mark !== undefined) {
      sum += amt * mark;
    }
  }

  for (const escrow of spotState.evmEscrows ?? []) {
    const amt = parseNumber(escrow.total);
    if (amt === 0) {
      continue;
    }

    if (escrow.coin === "USDC" || escrow.coin === "USDH") {
      sum += amt;
      continue;
    }

    const mark = usdMarkByBaseTokenIndex.get(escrow.token);
    if (mark !== undefined) {
      sum += amt * mark;
    }
  }

  return sum;
}

function normalizeTradeSide(side: "B" | "A"): TradeSide {
  return side === "B" ? "long" : "short";
}

function normalizeWalletAddress(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

function isCancelErrorStatus(status: unknown): status is { error: string } {
  return (
    typeof status === "object" &&
    status !== null &&
    "error" in status &&
    typeof (status as { error?: unknown }).error === "string"
  );
}

function mapCancelResults(
  requests: HyperliquidCancelOrderRequest[],
  statuses: unknown[],
): HyperliquidCancelOrderResult[] {
  return requests.map((request, index) => {
    const status = statuses[index];
    if (status === "success") {
      return {
        ...request,
        status: "success",
      };
    }

    if (isCancelErrorStatus(status)) {
      return {
        ...request,
        status: "error",
        error: status.error,
      };
    }

    return {
      ...request,
      status: "error",
      error: "Unexpected cancel response from Hyperliquid.",
    };
  });
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
  /** Cache: global spot pair metadata + marks (safe to reuse across users). */
  private spotMetaAndAssetCtxsCache?: Promise<SpotMetaAndAssetCtxsResponse>;

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

  private getSpotMetaAndAssetCtxs(): Promise<SpotMetaAndAssetCtxsResponse> {
    if (!this.spotMetaAndAssetCtxsCache) {
      this.spotMetaAndAssetCtxsCache = this.infoClient.spotMetaAndAssetCtxs();
    }

    return this.spotMetaAndAssetCtxsCache;
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

  /**
   * Sum of all `userFunding` ledger `delta.usdc` amounts (lifetime, all perp coins).
   * Paginates by `startTime` until a page is empty.
   */
  async fetchUserLifetimeFundingUsd(accountAddress: `0x${string}`): Promise<number> {
    let total = 0;
    let startTime = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const rows = await this.infoClient.userFunding({ user: accountAddress, startTime });
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        total += parseNumber(String(row.delta.usdc).trim());
      }

      const nextStart = Math.max(...rows.map((r) => r.time)) + 1;
      if (nextStart <= startTime) {
        break;
      }

      startTime = nextStart;
    }

    return total;
  }

  /**
   * Latest all-time cumulative PnL from the official portfolio API (same series as the Hyperliquid UI).
   */
  async fetchPortfolioAllTimePnlUsd(accountAddress: `0x${string}`): Promise<number> {
    const rows = await this.infoClient.portfolio({ user: accountAddress });
    for (const [period, data] of rows) {
      if (period !== "allTime") {
        continue;
      }

      const lastPoint = data.pnlHistory.at(-1);
      if (!lastPoint) {
        return 0;
      }

      return Number(lastPoint[1]);
    }

    return 0;
  }

  async fetchAccountSnapshot(accountAddress: `0x${string}`): Promise<HyperliquidAccountSnapshot> {
    const [abstraction, state] = await Promise.all([
      this.infoClient.userAbstraction({ user: accountAddress }),
      this.infoClient.clearinghouseState({ user: accountAddress }),
    ]);

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

    let accountValueUsd = parseNumber(state.marginSummary.accountValue);
    if (accountValueUsesSpotClearinghouseLedger(abstraction)) {
      try {
        const [spotState, spotMetaTuple] = await Promise.all([
          this.infoClient.spotClearinghouseState({ user: accountAddress }),
          this.getSpotMetaAndAssetCtxs(),
        ]);
        accountValueUsd = sumUnifiedSpotPortfolioUsd(spotState, spotMetaTuple);
      } catch {
        // Transient errors: keep perp margin summary (may disagree with UI in unified mode).
      }
    }

    return {
      accountValueUsd,
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

  async cancelOrders(requests: HyperliquidCancelOrderRequest[]): Promise<HyperliquidCancelOrderResult[]> {
    if (requests.length === 0) {
      return [];
    }

    const results = new Array<HyperliquidCancelOrderResult | undefined>(requests.length);
    const fallbackToCloid: Array<{ index: number; request: HyperliquidCancelOrderRequest; priorError: string }> = [];

    const oidRequests = requests
      .map((request, index) => ({ request, index }))
      .filter((entry) => entry.request.orderId !== undefined);

    if (oidRequests.length > 0) {
      const response = await this.exchangeClient.cancel({
        cancels: oidRequests.map(({ request }) => ({
          a: this.getAssetInfo(request.symbol).assetId,
          o: request.orderId!,
        })),
      });
      const mappedResults = mapCancelResults(
        oidRequests.map(({ request }) => request),
        response.response.data.statuses as unknown[],
      );

      for (const [resultIndex, result] of mappedResults.entries()) {
        const originalIndex = oidRequests[resultIndex]!.index;
        const originalRequest = requests[originalIndex]!;
        if (result.status === "success" || !originalRequest.clientOrderId) {
          results[originalIndex] = result;
          continue;
        }

        fallbackToCloid.push({
          index: originalIndex,
          request: originalRequest,
          priorError: result.error ?? "cancel by oid failed",
        });
      }
    }

    const directCloidRequests = requests
      .map((request, index) => ({ request, index }))
      .filter((entry) => entry.request.orderId === undefined && entry.request.clientOrderId !== undefined);
    const cloidRequests = [
      ...directCloidRequests.map((entry) => ({ ...entry, priorError: undefined as string | undefined })),
      ...fallbackToCloid,
    ];

    if (cloidRequests.length > 0) {
      const response = await this.exchangeClient.cancelByCloid({
        cancels: cloidRequests.map(({ request }) => ({
          asset: this.getAssetInfo(request.symbol).assetId,
          cloid: request.clientOrderId!,
        })),
      });
      const mappedResults = mapCancelResults(
        cloidRequests.map(({ request }) => request),
        response.response.data.statuses as unknown[],
      );

      for (const [resultIndex, result] of mappedResults.entries()) {
        const { index, request, priorError } = cloidRequests[resultIndex]!;
        if (result.status === "success") {
          results[index] = {
            ...request,
            status: "success",
          };
          continue;
        }

        results[index] = {
          ...request,
          status: "error",
          error: priorError
            ? `cancel by oid failed: ${priorError}; cancel by cloid failed: ${result.error ?? "unknown error"}`
            : result.error ?? "cancel by cloid failed",
        };
      }
    }

    return requests.map(
      (request, index) =>
        results[index] ?? {
          ...request,
          status: "error",
          error: "Cancel request is missing both oid and cloid.",
        },
    );
  }
}
