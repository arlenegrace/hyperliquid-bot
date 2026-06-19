# Crash hardening follow-up plan

Subagents reviewed the codebase for unhandled promise rejections and other crash vectors. Safe fixes (logging, catch blocks that preserve existing control flow) were applied immediately. This file tracks items that need a deliberate behavior decision before changing.

All 41 tests pass after the applied fixes.

---

## Already fixed (no behavior change)

These were implemented during the review:

| Area | Issue | Fix |
|------|-------|-----|
| `src/index.ts` | No global `unhandledRejection` handler | Log rejections instead of silent drop |
| `src/index.ts` | Inconsistent error formatting | Shared `formatError()` helper |
| `src/engine/websocketRunner.ts` | `void shutdown()` could reject and hang process | try/catch around `close()`, `.catch()` on shutdown promise |
| `src/engine/websocketRunner.ts` | Stream callbacks could throw into subscription library | try/catch around candle and account event handlers |
| `src/engine/liveBroker.ts` | Debounced protective-order flush had no rejection handler | try/catch in `flushDebouncedProtectiveOrders()` |
| `src/engine/liveBroker.ts` | `saveState()` disk errors could abort cycles | catch I/O errors, log, skip persist |
| `src/clients/hyperliquidSubscriptions.ts` | `close()` could reject on shutdown | Log unsubscribe/transport errors, never reject |
| `src/clients/hyperliquidSubscriptions.ts` | `failureSignal` race between subscribe and track | Check `aborted` synchronously after subscribe |
| `src/clients/hyperliquidExchange.ts` | Rejected cache promise poisoned forever | Clear cache on rejection |
| `src/clients/hyperliquidExchange.ts` | Extra order statuses could throw on `specs[index]!` | Map extras to error results |
| `src/analysis/reclaimFromRange.ts` | Empty excursion window returned ±Infinity stops | Fall back to deviation candle low/high |
| `strategies/index.ts` | Unknown strategy id returned undefined | Exhaustive default with clear error |

---

## Needs behavior decision

### High priority (live trading / process survival)

#### 1. Websocket bootstrap failure exits the process

**File:** `src/engine/websocketRunner.ts` (`bootstrapCandles`, called from `start`)

**Issue:** REST bootstrap + initial `runForClosedCandles()` has no catch. Any failure rejects `start()`, and `main().catch()` in `index.ts` calls `process.exit(1)`.

**Recommended fix:** Decide fail-fast vs. degraded start. Options:
- Keep fail-fast (current): bad bootstrap means no trading until config/network is fixed.
- Log-and-continue: start websocket feeds anyway with empty/stale candle state; first confirmed close cycle catches up.

---

#### 2. Subscription failure does not resubscribe

**File:** `src/engine/websocketRunner.ts` (`subscribeStreams` onFailure handlers)

**Issue:** Candle failures only log. Account failures call `markRemoteSubscriptionFailed` but nothing resubscribes. Transport has `reconnect: Infinity`, but an aborted `failureSignal` may leave feeds dead until manual restart.

**Recommended fix:** Add explicit resubscribe logic when `onFailure` fires, with backoff and logging. Needs decision on whether to pause trading while feeds are down.

---

#### 3. Protective order placement errors abort the cycle

**File:** `src/engine/liveBroker.ts` (`ensureProtectiveOrdersForPosition`)

**Issue:** `gateway.placeOrders()` for TP/SL is not wrapped in try/catch (unlike entry placement in `openPosition`). A transient API error aborts `drainRemoteEvents` / `onCycleStart` for that cycle. Positions may sit without updated protective orders until the next successful cycle.

**Recommended fix:** Catch per-order failures, log, optionally trigger REST reconcile. Match the pattern used for entry placement.

---

#### 4. Market-close orders in cancel/flatten paths can throw uncaught

**File:** `src/engine/liveBroker.ts` (`cancelPositionById`, `flattenOpposingExposure`)

**Issue:** Reduce-only market closes call `gateway.placeOrders()` without try/catch. A throw leaves local state partially updated and may not confirm the close on exchange.

**Recommended fix:** Wrap in try/catch, log failure, fall back to `syncRemoteState()`.

---

#### 5. Gateway stream callbacks can still throw before user listener

**File:** `src/clients/hyperliquidSubscriptions.ts` (`subscribeCandles`, `subscribeAccount`)

**Issue:** Normalization code inside gateway callbacks (e.g. `normalizeCandle`, `normalizeOpenOrder`) runs before the caller's try/catch in `websocketRunner`. A throw there can break WS message handling inside the SDK.

**Recommended fix:** Wrap the entire gateway callback body in try/catch with logging. Trade-off: one bad message is skipped vs. potentially killing the feed handler.

---

#### 6. WebSocket transport termination not surfaced

**File:** `src/clients/hyperliquidSubscriptions.ts`

**Issue:** Only per-subscription `failureSignal` is monitored. Permanent socket termination (`transport.socket.terminationSignal`) is not forwarded to `onFailure`. Mitigated by `maxRetries: Infinity`, but a terminal close could leave feeds silent without notification.

**Recommended fix:** Listen for transport-level termination and invoke `onFailure` or trigger reconnect/resubscribe.

---

### Medium priority (startup / recovery / visibility)

#### 7. Websocket shutdown may not exit the process

**File:** `src/index.ts` (websocket path)

**Issue:** Poll mode calls `process.exit(0)` on SIGINT. Websocket mode returns after `runner.start()` resolves with no explicit exit. Lingering handles may keep the process alive after shutdown.

**Recommended fix:** Add `process.exit(0)` after `await runner.start()` if shutdown should match poll mode.

---

#### 8. Corrupt state file crashes init

**File:** `src/engine/liveBroker.ts` (`loadState`)

**Issue:** Non-ENOENT errors (including invalid JSON) rethrow at startup. Intentional fail-fast, but recovery requires manual intervention or `npm run reconcile`.

**Recommended fix:** Detect parse errors, log clearly, optionally auto-backup and start fresh or prompt `--reset-state`.

---

#### 9. Corrupt manual range files crash boot or reload

**File:** `src/manualRanges.ts` (`loadManualRanges`, `loadManualRangeStates`)

**Issue:** JSON/Zod failures throw and abort boot or cycle reload. Only `ENOENT` on state file returns empty map.

**Recommended fix:** Graceful degradation (skip symbol, use last-good ranges) vs. keep fail-fast.

---

#### 10. Partial `subscribeAccount` failure leaves orphan subscriptions

**File:** `src/clients/hyperliquidSubscriptions.ts` (`subscribeAccount`)

**Issue:** Five subscriptions are awaited sequentially. If the 3rd fails, the first two stay active with no rollback.

**Recommended fix:** Transactional subscribe with rollback on failure, or document that partial subscribe is acceptable.

---

#### 11. Poll-mode cancel omits sync logs

**File:** `src/engine/liveBroker.ts` (`cancelPositionById`)

**Issue:** Websocket branch pushes `syncRemoteState()` logs into the return value; poll branch discards them. Not a crash risk, but operators lose visibility after manual closes in poll mode.

**Recommended fix:** `logs.push(...(await this.syncRemoteState()))` in the poll branch.

---

### Lower priority (backtest / strategy semantics)

#### 12. Bot cycle errors propagate to callers

**File:** `src/engine/bot.ts` (`runOnce`, `runForClosedCandles`)

**Issue:** Errors in `reloadManualRanges`, `broker.onCycleStart`, `logCycleSummary`, or `saveManualRangeStates` propagate to callers. Poll and websocket candle-close paths catch them; bootstrap does not (see item 1).

**Recommended fix:** Only if you want cycle failures never to bubble: wrap the cycle body in try/catch inside the bot. Changes whether partial cycle work is visible vs. fully aborted.

---

#### 13. Strategy evaluate throw reprocesses same candle

**File:** `src/engine/bot.ts` (`processSymbolCandles`)

**Issue:** Per-symbol try/catch prevents process crash, but on throw `lastProcessedCloseTime` is not updated, so the same candle may be reprocessed next cycle.

**Recommended fix:** Decide whether to mark candle processed on failure, skip symbol for N cycles, or keep retry semantics.

---

#### 14. In-place manual range state mutation before broker confirms

**File:** `strategies/manualRangeTrading.ts` (`evaluate`)

**Issue:** State (reclaim timestamps, `activeOrderPlan`, edge flags) is mutated before the broker confirms orders. If a later step fails, state may be ahead of exchange reality.

**Recommended fix:** Copy-on-write or persist state only after broker confirmation. Changes state timing semantics.

---

#### 15. Backtest has no per-evaluation error isolation

**File:** `src/backtest/runStrategyComparison.ts`

**Issue:** `strategy.evaluate()` is uncaught inside `runBacktest`. One throw aborts that backtest and fails `Promise.all` for all strategies.

**Recommended fix:** Per-symbol/per-strategy try/catch if comparisons should continue after an error.

---

#### 16. `placeOrders` short status arrays from exchange

**File:** `src/clients/hyperliquidExchange.ts` (`placeOrders`)

**Issue:** If Hyperliquid returns fewer statuses than orders sent, trailing orders get no result entry. Padding with error results would change how `liveBroker` treats those orders.

**Recommended fix:** Pad missing entries with explicit error results and decide how liveBroker should react.

---

#### 17. Candle fetch pagination has no max-iteration guard

**File:** `src/clients/hyperliquid.ts` (`fetchCandlesInRange`)

**Issue:** No cap on pagination loops. A misbehaving API returning duplicate pages could hang indefinitely (not a rejection, but process stall).

**Recommended fix:** Add max-iteration guard with error log.

---

## Suggested order of follow-up

1. Items 3 and 4 (protective orders and market closes) — direct live-trading risk during API blips.
2. Items 1 and 2 (bootstrap and resubscribe) — process survival in websocket mode.
3. Items 5 and 6 (gateway callback guards and transport termination) — feed reliability.
4. Items 7–11 — operational polish and recovery paths.
5. Items 12–17 — strategy/backtest semantics (lower urgency for production bot).
