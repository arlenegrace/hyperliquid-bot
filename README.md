# Hyperliquid Trading Bot

A TypeScript automated trading bot for the [Hyperliquid](https://hyperliquid.xyz) perpetuals exchange. The bot monitors a watchlist of crypto assets, detects chart patterns called **range reclaims**, and places laddered limit orders automatically — including stop losses and take profits.

It supports **paper trading** (simulated with no real money) and a guarded **live trading** mode backed by a dedicated wallet.

---

## How it works

### What is a "range"?

A price range is a zone where an asset has historically bounced between a high and a low price multiple times. These zones often act as support or resistance.

### What is a "range reclaim"?

A range reclaim happens when price breaks out of the range (closes a candle outside the boundary), and then closes back inside. This signals that the breakout failed and price is likely to continue toward the opposite side of the range, a high-probability mean-reversion trade.

### Why 4-hour candles?

The bot evaluates signals on fully closed **4-hour candles**. This timeframe offers the best signal-to-noise ratio for this strategy:

- Shorter candles (1h, 2h) have more false breakouts, leading to more stop loss hits.
- Longer candles (8h, 1D) mean too much time passes after the reclaim; by the time the candle closes, price has already moved far from the range edge, making limit order fills less likely.

### What is "laddering"?

Instead of placing one large order at a single price, the bot spreads entries and exits across several limit orders at different prices within a band near the range edge. This improves average fill price and reduces the impact of missing the exact level by a small amount.

---

## Strategies

The active strategy is configured in `config.json` via `activeStrategyId`. The **default is `manual-range-trading-v1`**.

### `manual-range-trading-v1` *(default)*

- Reads range levels from `manual-ranges.json`.
- Waits for a candle to close outside the range, then waits for a later candle to close back inside.
- Sizes positions using a fixed USD notional (e.g. `$200 per trade`).
- Ladders entries near the range edge and exits across the range.

Use this strategy when you want a simple, predictable dollar amount per trade.

### `manual-range-trading-v2`

- Same reclaim logic as v1.
- Sizes positions based on **stop-defined risk** — the position size is calculated so that hitting the stop loses a fixed percentage of account equity, rather than a fixed dollar amount.

### `manual-range-trading-v3`

- Extends v2 with additional filters and refinements.

### `manual-range-trading` *(legacy)*

- An earlier variant kept in the repo for backtesting comparison.
- Uses a single entry on a fresh reclaim or a split ladder when re-entering an existing setup.
- Takes 50% profit at mid-range and holds the rest for a reversal near the far side.

---

## Manual range workflow

The file `manual-ranges.json` is where you define the price ranges you want the bot to trade.

Each entry includes:

- `symbol` — the asset (e.g. `"BTC"`)
- `rangeLow` — the bottom of the range
- `rangeHigh` — the top of the range
- `validFromTime` *(optional)* — ignore reclaims before this timestamp
- `notes` *(optional)* — your own annotation

Example:

```json
{
  "ranges": [
    {
      "symbol": "BTC",
      "rangeLow": 65100,
      "rangeHigh": 72200,
      "validFromTime": "2026-02-12T20:00:00.000Z",
      "notes": "Feb consolidation box"
    }
  ]
}
```

### Range invalidation

A range is automatically invalidated if price closes more than **50% of the range width** beyond either boundary.

Example with `rangeLow = 65100` and `rangeHigh = 72200`:

- Range width = `7100`
- Invalidation above = `72200 + 3550 = 75750`
- Invalidation below = `65100 - 3550 = 61550`

Once invalidated, the bot stops taking new trades on that asset until you update `manual-ranges.json`.

---

## What "no current setup" means

When the bot logs "no current setup," it means the **most recently closed 4h candle** did not produce a fresh entry signal.

It does **not** mean:

- your historical trade ideas were wrong,
- your manual range was rejected,
- or the bot found no setups anywhere in the past.

A strategy can correctly identify multiple past setups while still having nothing actionable on the latest candle.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your config file

```bash
copy config.example.json config.json
```

### 3. Edit `config.json`

Set your watchlist, strategy, position size, and any other settings. See the [Configuration](#configuration) section below.

### 4. Define your ranges

Edit `manual-ranges.json` with the coins and price levels you want the bot to monitor.

### 5. Run in paper mode

```bash
npm run dev
```

This simulates trades with no real money using your configured starting balance.

---

## Live trading setup

> **Use a dedicated wallet** — fund a separate wallet with only the amount you want the bot to control. Do not use your main wallet.

1. Fund a dedicated wallet.
2. Copy `.env.example` to `.env` and fill in `HL_ACCOUNT_ADDRESS` and `HL_PRIVATE_KEY`.
3. Set your initial live config in `config.json`:

```json
{
  "executionMode": "live",
  "activeStrategyId": "manual-range-trading-v1",
  "positionSizeUsd": 20,
  "live": {
    "enabled": false,
    "dryRun": true
  }
}
```

1. Run `npm run check` and confirm the bot initializes without placing orders.
2. Once satisfied, enable live writes:

```json
{
  "live": {
    "enabled": true,
    "dryRun": false
  }
}
```

### Safety switches


| Setting                  | Effect                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `executionMode: "paper"` | Forces simulation regardless of live credentials                                   |
| `live.dryRun: true`      | Initializes the live broker and reads account data, but blocks all order placement |
| `live.enabled: false`    | Disables exchange writes even when `executionMode` is `"live"`                     |


---

## Configuration

All settings live in `config.json` (copy from `config.example.json`).

```json
{
  "apiBaseUrl": "https://api.hyperliquid.xyz",
  "watchlist": ["BTC", "ETH", "SOL", "CRV", "BNB", "XRP", "SUI"],
  "pollIntervalMs": 60000,
  "executionMode": "paper",
  "activeStrategyId": "manual-range-trading-v1",
  "paperStartingBalanceUsd": 20,
  "positionSizeUsd": 100,
  "live": {
    "enabled": false,
    "dryRun": true,
    "useTestnet": false,
    "defaultLeverage": "max",
    "marginMode": "cross",
    "maxNotionalUsd": 1000,
    "maxOpenPositions": 3,
    "slippageBps": 10,
    "orderTimeoutMs": 10000
  },
  "manualRangeFile": "manual-ranges.json",
  "ladderLevels": 5,
  "signalExpiryCandles": 18,
  "backtestSymbols": ["BTC", "ETH", "SOL", "CRV", "BNB"],
  "backtestLookbackCandles": 900
}
```

> Wallet credentials (`HL_ACCOUNT_ADDRESS`, `HL_PRIVATE_KEY`) are secrets and live in `.env`, not `config.json`. Copy `.env.example` to `.env` to set them.

### Key settings


| Setting                   | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `executionMode`           | `"paper"` for simulation, `"live"` for real trading        |
| `activeStrategyId`        | Which strategy to run (default: `manual-range-trading-v1`) |
| `positionSizeUsd`         | Fixed dollar amount per trade (used by v1)                 |
| `live.enabled`            | Master kill-switch for real exchange writes                |
| `live.dryRun`             | Validates the live path without placing orders             |
| `live.maxNotionalUsd`     | Caps the planned size of any single live trade             |
| `live.maxOpenPositions`   | Limits how many positions the bot can hold at once         |
| `signalExpiryCandles`     | How many candles a pending entry remains valid             |
| `backtestLookbackCandles` | How much historical data the backtest uses                 |


---

## Commands

```bash
npm run dev
```

Runs the bot in watch mode, re-evaluating signals on each new 4h candle.

```bash
npm run check
```

Runs one scan and exits. Recommended for verifying live setup before enabling writes.

```bash
npm run backtest:compare
```

Backtests all strategies on recent BTC/ETH history and prints a performance summary.

```bash
npm run build
npm start
```

Compiles the TypeScript and runs the production build.

```bash
npm run test
```

Runs unit tests for config parsing, strategy selection, broker initialization, live sizing guardrails, and paper broker behavior.

---

## Project structure

```
.
├── config.json              # Your local config (not committed)
├── config.example.json      # Template to copy from
├── manual-ranges.json       # Your defined price ranges
├── strategies/
│   ├── ladderUtils.ts
│   ├── manualRangeTrading.ts
│   ├── manualRangeTradingV1.ts
│   ├── manualRangeTradingV2.ts
│   ├── manualRangeTradingV3.ts
│   └── index.ts
└── src/
    ├── analysis/
    │   └── reclaimFromRange.ts
    ├── backtest/
    │   └── runStrategyComparison.ts
    ├── clients/
    │   ├── hyperliquid.ts
    │   └── hyperliquidExchange.ts
    ├── engine/
    │   ├── bot.ts
    │   ├── createBroker.ts
    │   ├── liveBroker.ts
    │   ├── liveGuardrails.ts
    │   └── paperBroker.ts
    ├── config.ts
    ├── manualRanges.ts
    ├── index.ts
    └── types.ts
```

---

## Possible improvements

- Persist invalidation state and backtest reports to disk for easier iteration.
- Add websocket-based order and fill subscriptions so protective orders react faster than the polling loop.
- Scale live position size gradually after confirming behavior across several weeks of paper and small-wallet live tracking.

