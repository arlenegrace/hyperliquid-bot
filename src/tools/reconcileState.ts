import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import {
  HyperliquidExchangeGateway,
  type HyperliquidAccountPosition,
  type HyperliquidFrontendOpenOrder,
} from "../clients/hyperliquidExchange.js";
import type { BrokerPosition, PositionExitOrder, PositionStopOrder, TradeSide } from "../types.js";

const POSITION_EPSILON = 1e-9;

interface LiveBrokerStateFile {
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeesUsd: number;
  wins: number;
  losses: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  nextPositionSequence: number;
  lastSyncTime: number;
  processedTradeIds: number[];
  lastMarks: Record<string, number>;
  openPositions: BrokerPosition[];
  closedPositions: BrokerPosition[];
  cancelledPositions: BrokerPosition[];
}

function resolveStatePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function oppositeTradeSide(side: TradeSide): TradeSide {
  return side === "long" ? "short" : "long";
}

function isActivePosition(position: BrokerPosition): boolean {
  return position.status !== "closed" && position.status !== "cancelled";
}

function closingSideForPosition(position: BrokerPosition): TradeSide {
  return oppositeTradeSide(position.side);
}

function isStopOrder(order: HyperliquidFrontendOpenOrder): boolean {
  return order.isTrigger && order.orderType.toLowerCase().includes("stop");
}

function isTakeProfitOrder(order: HyperliquidFrontendOpenOrder): boolean {
  return order.isTrigger && order.orderType.toLowerCase().includes("take profit");
}

function isClosingReduceOnlyOrder(position: BrokerPosition, order: HyperliquidFrontendOpenOrder): boolean {
  return order.reduceOnly && order.side === closingSideForPosition(position);
}

function syncPositionSizeFromExchange(position: BrokerPosition, exchangePos: HyperliquidAccountPosition): string[] {
  const logs: string[] = [];

  if (Math.abs(position.remainingSizeUnits - exchangePos.sizeUnits) > POSITION_EPSILON) {
    logs.push(
      `  ${position.symbol}: updated remaining size ${position.remainingSizeUnits} -> ${exchangePos.sizeUnits}`,
    );
    position.remainingSizeUnits = exchangePos.sizeUnits;
  }

  if (Math.abs(position.filledSizeUnits - exchangePos.sizeUnits) > POSITION_EPSILON) {
    logs.push(`  ${position.symbol}: updated filled size ${position.filledSizeUnits} -> ${exchangePos.sizeUnits}`);
    position.filledSizeUnits = exchangePos.sizeUnits;
  }

  if (exchangePos.entryPrice !== undefined) {
    const previousAverage = position.averageEntryPrice;
    position.averageEntryPrice = exchangePos.entryPrice;
    if (previousAverage !== undefined && Math.abs(previousAverage - exchangePos.entryPrice) > POSITION_EPSILON) {
      logs.push(
        `  ${position.symbol}: updated average entry ${previousAverage} -> ${exchangePos.entryPrice}`,
      );
    }
  }

  if (position.status === "pending" && exchangePos.sizeUnits > POSITION_EPSILON) {
    position.status = "open";
    logs.push(`  ${position.symbol}: marked position ${position.id} as open`);
  }

  return logs;
}

function syncProtectiveOrdersFromExchange(
  position: BrokerPosition,
  exchangeOrders: HyperliquidFrontendOpenOrder[],
): string[] {
  const logs: string[] = [];
  const symbolOrders = exchangeOrders.filter((order) => order.symbol === position.symbol);
  const closingOrders = symbolOrders.filter((order) => isClosingReduceOnlyOrder(position, order));
  const stopOrders = closingOrders.filter(isStopOrder);
  const takeProfitOrders = closingOrders.filter(isTakeProfitOrder).sort((left, right) => left.triggerPx - right.triggerPx);

  if (stopOrders.length > 1) {
    logs.push(
      `  ${position.symbol}: found ${stopOrders.length} stop orders on exchange; expected one. Skipping stop sync.`,
    );
  } else if (stopOrders.length === 1) {
    const stopOrder = stopOrders[0]!;
    const stopSizeUnits =
      stopOrder.sizeUnits > POSITION_EPSILON ? stopOrder.sizeUnits : position.remainingSizeUnits;

    if (Math.abs(position.stopLoss - stopOrder.triggerPx) > POSITION_EPSILON) {
      logs.push(`  ${position.symbol}: updated stop loss ${position.stopLoss} -> ${stopOrder.triggerPx}`);
      position.stopLoss = stopOrder.triggerPx;
    }

    const nextStopOrder: PositionStopOrder = {
      price: stopOrder.triggerPx,
      sizeUnits: stopSizeUnits,
      status: "pending",
      exchangeOrderId: stopOrder.orderId,
      ...(stopOrder.clientOrderId ? { clientOrderId: stopOrder.clientOrderId } : {}),
    };

    const previousStopOrderId = position.stopOrder?.exchangeOrderId;
    position.stopOrder = nextStopOrder;
    if (previousStopOrderId !== stopOrder.orderId) {
      logs.push(
        `  ${position.symbol}: linked stop order on exchange (trigger ${stopOrder.triggerPx}, oid ${stopOrder.orderId})`,
      );
    }
  } else if (position.stopOrder?.exchangeOrderId !== undefined) {
    position.stopOrder.status = "cancelled";
    delete position.stopOrder.exchangeOrderId;
    delete position.stopOrder.clientOrderId;
    logs.push(`  ${position.symbol}: cleared local stop order because none is open on the exchange`);
  }

  if (takeProfitOrders.length > 0) {
    const coverageBaseUnits = position.remainingSizeUnits;
    const nextExitOrders: PositionExitOrder[] = takeProfitOrders.map((order, index) => ({
      label: `Exit ${index + 1}`,
      price: order.triggerPx,
      sizeFraction: coverageBaseUnits > POSITION_EPSILON ? order.sizeUnits / coverageBaseUnits : 0,
      sizeUnits: order.sizeUnits,
      status: "pending",
      exchangeOrderId: order.orderId,
      ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
    }));

    const previousSummary = position.exitOrders
      .map((order) => `${order.price}@${order.sizeUnits}`)
      .join(", ");
    const nextSummary = nextExitOrders.map((order) => `${order.price}@${order.sizeUnits}`).join(", ");

    position.exitOrders = nextExitOrders;
    if (previousSummary !== nextSummary) {
      logs.push(`  ${position.symbol}: synced take-profit ladder from exchange: ${nextSummary}`);
    }
  } else {
    for (const order of position.exitOrders) {
      if (order.status === "pending" && order.exchangeOrderId !== undefined) {
        order.status = "cancelled";
        delete order.exchangeOrderId;
        delete order.clientOrderId;
      }
    }
  }

  return logs;
}

function findBestCancelledPositionMatch(
  state: LiveBrokerStateFile,
  symbol: string,
  exchangePos: HyperliquidAccountPosition,
  symbolFills: Array<{ clientOrderId?: `0x${string}` }>,
): BrokerPosition | undefined {
  const candidates = state.cancelledPositions.filter(
    (position) => position.symbol === symbol && position.side === exchangePos.side && position.status === "cancelled",
  );

  if (candidates.length === 0) {
    return undefined;
  }

  const fillClientOrderIds = new Set(
    symbolFills.flatMap((fill) => (fill.clientOrderId ? [fill.clientOrderId] : [])),
  );

  for (const candidate of candidates) {
    const hasMatchingFill = candidate.entryOrders.some(
      (order) => order.clientOrderId !== undefined && fillClientOrderIds.has(order.clientOrderId),
    );
    if (hasMatchingFill) {
      return candidate;
    }
  }

  if (exchangePos.entryPrice !== undefined) {
    const byEntryPrice = candidates
      .filter((candidate) => candidate.averageEntryPrice !== undefined)
      .sort(
        (left, right) =>
          Math.abs((left.averageEntryPrice ?? 0) - exchangePos.entryPrice!) -
          Math.abs((right.averageEntryPrice ?? 0) - exchangePos.entryPrice!),
      );
    if (byEntryPrice.length > 0) {
      return byEntryPrice[0];
    }
  }

  return candidates[0];
}

function collectStaleEntryOrders(
  state: LiveBrokerStateFile,
  exchangeOrders: HyperliquidFrontendOpenOrder[],
): HyperliquidFrontendOpenOrder[] {
  const activeEntryClientOrderIds = new Set<`0x${string}`>();
  const filledEntryClientOrderIds = new Set<`0x${string}`>();

  for (const position of state.openPositions) {
    if (!isActivePosition(position)) {
      continue;
    }

    for (const order of position.entryOrders) {
      if (!order.clientOrderId) {
        continue;
      }

      if (order.status === "pending") {
        activeEntryClientOrderIds.add(order.clientOrderId);
      }

      if (order.status === "filled") {
        filledEntryClientOrderIds.add(order.clientOrderId);
      }
    }
  }

  const cancelledEntryClientOrderIds = new Set<`0x${string}`>();
  for (const position of state.cancelledPositions) {
    for (const order of position.entryOrders) {
      if (order.clientOrderId) {
        cancelledEntryClientOrderIds.add(order.clientOrderId);
      }
    }
  }

  return exchangeOrders.filter((order) => {
    if (order.reduceOnly || !order.clientOrderId) {
      return false;
    }

    if (cancelledEntryClientOrderIds.has(order.clientOrderId)) {
      return true;
    }

    if (filledEntryClientOrderIds.has(order.clientOrderId)) {
      return true;
    }

    return !activeEntryClientOrderIds.has(order.clientOrderId);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const statePath = resolveStatePath(config.live.stateFile);

  let state: LiveBrokerStateFile;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as LiveBrokerStateFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(`State file not found at ${statePath}. Nothing to reconcile.`);
      process.exit(1);
    }
    throw error;
  }

  const gateway = new HyperliquidExchangeGateway(config.apiBaseUrl, config.live);
  await gateway.initialize();
  const accountAddress = gateway.validateAccountAddress(config.live.accountAddress);

  console.log(`Reconciling state for account ${accountAddress}`);
  console.log(`State file: ${statePath}`);

  const [accountSnapshot, exchangeOrders, fills] = await Promise.all([
    gateway.fetchAccountSnapshot(accountAddress),
    gateway.fetchFrontendOpenOrders(accountAddress),
    gateway.fetchFillsSince(accountAddress, Date.now() - 7 * 24 * 60 * 60 * 1000),
  ]);

  const trackedOpenSymbols = new Set(
    state.openPositions.filter(isActivePosition).map((position) => position.symbol),
  );
  const exchangeSymbols = new Set(accountSnapshot.positionsBySymbol.keys());

  const untrackedSymbols = [...exchangeSymbols].filter((symbol) => !trackedOpenSymbols.has(symbol));
  const orphanedLocal = [...trackedOpenSymbols].filter((symbol) => !exchangeSymbols.has(symbol));

  console.log(`\nExchange positions: ${[...exchangeSymbols].join(", ") || "(none)"}`);
  console.log(`Tracked open positions: ${[...trackedOpenSymbols].join(", ") || "(none)"}`);

  if (orphanedLocal.length > 0) {
    console.log(`\nLocally tracked but not on exchange: ${orphanedLocal.join(", ")}`);
    console.log("These positions will be closed in the state file.");
  }

  if (untrackedSymbols.length > 0) {
    console.log(`\nOn exchange but not tracked locally: ${untrackedSymbols.join(", ")}`);
    console.log("These will be recovered from exchange fill history.");
  }

  const staleEntryOrders = collectStaleEntryOrders(state, exchangeOrders);
  const matchedSymbols = [...exchangeSymbols].filter((symbol) => trackedOpenSymbols.has(symbol));
  const needsOrderSync = matchedSymbols.length > 0;
  const needsChanges =
    orphanedLocal.length > 0 || untrackedSymbols.length > 0 || staleEntryOrders.length > 0 || needsOrderSync;

  if (!needsChanges) {
    console.log("\nState is already consistent with the exchange. No changes needed.");
    return;
  }

  const backupPath = `${statePath}.backup-${Date.now()}`;
  await copyFile(statePath, backupPath);
  console.log(`\nBacked up current state to ${backupPath}`);

  let changed = false;
  const changeLogs: string[] = [];

  for (const symbol of orphanedLocal) {
    const positions = state.openPositions.filter((position) => position.symbol === symbol && isActivePosition(position));
    for (const position of positions) {
      position.status = "closed";
      position.closeReason = "reconciled: no matching exchange position";
      position.closedAt = Date.now();
      state.closedPositions.push({ ...position });
      changeLogs.push(`Closed orphaned local position ${position.id} (${position.symbol} ${position.side})`);
    }
    state.openPositions = state.openPositions.filter(
      (position) =>
        !(
          position.symbol === symbol &&
          position.status === "closed" &&
          position.closeReason === "reconciled: no matching exchange position"
        ),
    );
    changed = true;
  }

  for (const symbol of untrackedSymbols) {
    const exchangePos = accountSnapshot.positionsBySymbol.get(symbol)!;
    const symbolFills = fills
      .filter((fill) => fill.symbol === symbol && fill.side === exchangePos.side)
      .sort((left, right) => left.time - right.time);

    const totalFeeUsd = symbolFills.reduce((sum, fill) => sum + fill.feeUsd, 0);
    const cancelledMatch = findBestCancelledPositionMatch(state, symbol, exchangePos, symbolFills);

    if (cancelledMatch) {
      changeLogs.push(`Restoring cancelled position ${cancelledMatch.id} (${symbol} ${exchangePos.side})`);

      cancelledMatch.status = "open";
      cancelledMatch.filledSizeUnits = exchangePos.sizeUnits;
      cancelledMatch.remainingSizeUnits = exchangePos.sizeUnits;
      cancelledMatch.averageEntryPrice = exchangePos.entryPrice ?? 0;
      cancelledMatch.intendedSizeUnits = Math.max(cancelledMatch.intendedSizeUnits, exchangePos.sizeUnits);
      delete cancelledMatch.closeReason;
      delete cancelledMatch.closedAt;

      for (const order of cancelledMatch.entryOrders) {
        const matchingFill = symbolFills.find(
          (fill) => fill.clientOrderId !== undefined && fill.clientOrderId === order.clientOrderId,
        );
        if (matchingFill) {
          order.status = "filled";
          order.filledSizeUnits = order.sizeUnits;
          order.averageFillPrice = matchingFill.price;
          order.feePaidUsd = matchingFill.feeUsd;
          order.filledAt = matchingFill.time;
          order.exchangeOrderId = matchingFill.orderId;
        } else if (order.status !== "filled") {
          order.status = "cancelled";
        }
      }

      state.openPositions.push(cancelledMatch);
      state.cancelledPositions = state.cancelledPositions.filter((position) => position.id !== cancelledMatch.id);

      for (const fill of symbolFills) {
        state.processedTradeIds.push(fill.tradeId);
      }
    } else {
      changeLogs.push(
        `Creating synthetic position for ${symbol} ${exchangePos.side} (${exchangePos.sizeUnits} units @ ${exchangePos.entryPrice})`,
      );

      const seq = state.nextPositionSequence++;
      const positionId = `reconciled-${symbol}-${Date.now()}-${seq}`;
      const entryPrice = exchangePos.entryPrice ?? 0;

      const position: BrokerPosition = {
        id: positionId,
        symbol,
        strategyId: "reconciled",
        side: exchangePos.side,
        entryReferencePrice: entryPrice,
        signalTime: Date.now(),
        expiryTime: Date.now() + 365 * 24 * 60 * 60 * 1000,
        stopLoss: 0,
        intendedSizeUnits: exchangePos.sizeUnits,
        filledSizeUnits: exchangePos.sizeUnits,
        averageEntryPrice: entryPrice,
        remainingSizeUnits: exchangePos.sizeUnits,
        entryOrders: [
          {
            label: "reconciled-entry",
            price: entryPrice,
            sizeUnits: exchangePos.sizeUnits,
            status: "filled",
            filledSizeUnits: exchangePos.sizeUnits,
            averageFillPrice: entryPrice,
            feePaidUsd: totalFeeUsd,
          },
        ],
        exitOrders: [
          {
            label: "reconciled-exit",
            price: 0,
            sizeFraction: 1,
            sizeUnits: exchangePos.sizeUnits,
            status: "pending",
          },
        ],
        realizedPnlUsd: -totalFeeUsd,
        status: "open",
      };

      state.openPositions.push(position);

      for (const fill of symbolFills) {
        state.processedTradeIds.push(fill.tradeId);
      }
    }

    changed = true;
  }

  for (const symbol of matchedSymbols) {
    const exchangePos = accountSnapshot.positionsBySymbol.get(symbol)!;
    const activePositions = state.openPositions.filter(
      (position) => position.symbol === symbol && isActivePosition(position),
    );

    if (activePositions.length > 1) {
      console.log(
        `\n${symbol}: multiple active local positions found (${activePositions.map((position) => position.id).join(", ")}). Skipping order sync for this symbol.`,
      );
      continue;
    }

    const position = activePositions[0];
    if (!position) {
      continue;
    }

    console.log(`\nSyncing ${symbol} position ${position.id} with exchange orders...`);
    const sizeLogs = syncPositionSizeFromExchange(position, exchangePos);
    const orderLogs = syncProtectiveOrdersFromExchange(position, exchangeOrders);
    if (sizeLogs.length > 0 || orderLogs.length > 0) {
      changeLogs.push(...sizeLogs, ...orderLogs);
      changed = true;
    }
  }

  if (staleEntryOrders.length > 0) {
    console.log(`\nCancelling ${staleEntryOrders.length} stale entry order(s) still open on the exchange...`);
    const cancelResults = await gateway.cancelOrders(
      staleEntryOrders.map((order) => ({
        symbol: order.symbol,
        orderId: order.orderId,
        ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
      })),
    );

    for (const [index, order] of staleEntryOrders.entries()) {
      const result = cancelResults[index];
      if (result?.status === "success") {
        changeLogs.push(
          `Cancelled stale ${order.symbol} entry order oid ${order.orderId} (${order.clientOrderId ?? "manual"})`,
        );
        changed = true;
        continue;
      }

      console.log(
        `  Failed to cancel stale ${order.symbol} entry oid ${order.orderId}: ${result?.error ?? "unknown error"}`,
      );
    }
  }

  if (changed) {
    state.processedTradeIds = [...new Set(state.processedTradeIds)];
    state.lastSyncTime = Date.now();
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    if (changeLogs.length > 0) {
      console.log("\nChanges:");
      for (const logLine of changeLogs) {
        console.log(`  ${logLine}`);
      }
    }

    console.log(`\nState file updated. Restart the bot to pick up the changes.`);
    return;
  }

  console.log("\nNo state changes were applied.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exit(1);
});
