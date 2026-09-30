# Polymarket BTC 5m Strategy Lab

A paper-trading lab for Polymarket's **"Bitcoin Up or Down" 5-minute** markets. It runs a set of
strategies, from safe to risky, side by side on live market data. It records that data so the
same strategies can be backtested later, and it learns from every settled round.

Live trading is optional and off by default. When turned on, it copies one strategy that has
already shown a profitable simulated track record.

## Why it works this way

A 5-minute Up/Down round asks: *will the Chainlink BTC/USD price at the end be ≥ the price at the
start?* With `S` the current Chainlink price, `K` the price to beat, `τ` the seconds left and `σ`
recent volatility, the fair probability is

```
P(UP) = Φ( ln(S/K) / (σ·√τ) )
```

The market already prices most of this. A small edge can come from two places:

- **Being a little better calibrated than the crowd**, especially late in the round when the
  answer is nearly decided.
- **Reacting faster**, because Binance usually moves slightly before the aggregated Chainlink
  price.

The aim is **many small positive-expectation bets**, sized with fractional Kelly, placed only
when the edge after **fees and spread** is large enough. Polymarket charges takers
`shares × 0.07 × p × (1 − p)` on these markets; makers pay nothing.

## Components

| Piece | File | What it does |
|---|---|---|
| Feeds | `src/data/chainlinkFeed.js`, `binanceWs.js`, `polymarket.js` | Chainlink (the settlement feed), Binance trades, order books, and official outcomes from Gamma |
| Market state | `src/sim/marketState.js` | Price-to-beat latch, volatility, Binance–Chainlink lead, staleness checks |
| Strategies | `src/strategy/strategies.js`, `decide.js` | Preset strategies from safe to risky; fee-aware entry and Kelly sizing |
| Learner | `src/strategy/learner.js` | Online logistic model of P(UP), trained on every settled round |
| Adaptive | `src/strategy/adaptive.js` | Thompson sampling over 36 shadow strategy variants; bets only on variants with a proven edge |
| Engine | `src/sim/engine.js` | Paper fills (order-book walk, latency, fees, maker queue rules), settlement, P&L, persistence |
| Recorder / backtest | `src/sim/recording.js`, `src/scripts/backtest.js` | Records raw events and replays them through the same engine |

**Data safety.** Nothing trades unless all of these are true:

- The Chainlink price is under 5 seconds old.
- The order books are under 3 seconds old.
- The price to beat was captured from a tick at the round's start.
- Volatility has warmed up.

Outcomes always come from Polymarket's resolved market. The bot never uses its own price
comparison. Each round, the captured price to beat is checked against Polymarket's official
value, and the average difference is shown on screen.

## Strategies

| id | Risk | Idea |
|---|---|---|
| `naive-favorite` | control | Buys the favorite about 60s before the end with no edge check. This approximates an average player and is the baseline to beat. |
| `conservative` | 1 | Uses only the volatility model, buys favorites only, needs a ≥4¢/share edge, stakes at most 3% of bankroll |
| `maker-patient` | 2 | Places resting bids below fair value, so no fee and no spread, but fills are adverse-selected |
| `balanced` | 3 | Uses the learned model, needs a ≥2.5¢ edge, 20% Kelly |
| `aggressive` | 4 | Needs a thin ≥1.5¢ edge, wide entry window, 35% Kelly |
| `degen` | 5 | Takes almost any positive edge, including long shots. This shows what over-trading costs. |
| `adaptive` | 3 | Each round, follows whichever shadow variant has the best recent return, measured by its lower confidence bound. Sits out until a variant has proven itself. |

All strategies:

- Settle on the official outcome.
- Pay the real fee schedule.
- Fill against the recorded order book after a configurable latency.
- Never switch sides within a round.

## Running it

```bash
npm install
npm start            # paper-trade every strategy on live data and record it
npm run dashboard    # http://127.0.0.1:3000 — leaderboard, equity curves, model scorecard
```

Let it run for a few days. The console and dashboard show equity, ROI, win rate, P&L against
*expected* P&L, fees, return per dollar staked, and max drawdown for each strategy. They also show
the learner's out-of-sample log-loss compared with the plain volatility model and the market.

State (bankrolls, the learned model, adaptive statistics) is saved in `logs/sim_state.json` and
survives restarts. Settled simulated trades are appended to `logs/sim_trades.csv`.

### Backtesting on recorded data

```bash
npm run backtest                                         # all of logs/recordings
npm run backtest -- --from 2026-09-01 --to 2026-09-07
npm run backtest -- --bankroll 50 --latency 1000 --strategies conservative,balanced,adaptive
npm run report -- --file logs/backtests/<run>/trades.csv # breakdown by price, timing, side, hour
```

Outcomes are injected 60 seconds after each round ends, in time order, so the learner and the
adaptive selector never see the future. Change `--latency` to test how sensitive a strategy is to
execution speed.

### Tests

```bash
npm test
```

The suite includes synthetic markets that check three things:

- Strategies profit when the market is genuinely mispriced.
- The conservative strategy stays out and the naive control loses to fees when the market is
  efficient.
- The books balance exactly.

## Going live (carefully)

1. Paper-trade until the strategy you want has at least `LIVE_MIN_SIM_BETS` settled bets with
   positive P&L. The executor enforces this.
2. Set `ENABLE_LIVE_TRADING=true`, `LIVE_STRATEGY=<id>`, `PRIVATE_KEY` and
   `POLYMARKET_FUNDER_ADDRESS`.
3. Keep `MAX_LIVE_STAKE_USD` small and set `DAILY_LOSS_LIMIT_USD`.

Live orders are FAK market buys whose worst price is the highest price that still clears the
strategy's minimum edge after fees. Only taker strategies can be copied live.

Things the simulation cannot capture:

- **Queue position** for maker orders. The fill rule is conservative.
- **Competition for the same liquidity.** Each strategy fills against the full book
  independently.
- **Your own market impact** beyond walking the recorded book.
- **The minimum order size.** Polymarket's minimum is 5 shares, so the smallest bet is about
  5 × price.

## Requirements

- Node.js 18+ (tested on 22)
- For running on a server under PM2, see [quickstart.md](quickstart.md)
