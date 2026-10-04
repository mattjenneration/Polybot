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

## Weather trader (daily high/low temperature markets)

A separate paper trader for Polymarket's "Highest/Lowest temperature in <city> on <date>" markets
(about 49 cities, high and low, two to three days listed at once). It runs in **learning mode**: it
trades on paper for days or weeks, and what it learns decides how much to bid, on which cities, and
when.

```bash
npm run sim:weather                  # foreground; or npm run pm2:start (pm2 app "weather-sim")
npm run dashboard                    # http://127.0.0.1:3000/weather.html
npm run report:weather               # leaderboard, what's been learned, go-live checklist
npm run weather:backfill -- --days 60 --stations KLGA,EGLC   # optional; runs automatically per new station
```

**How these markets resolve.** This was checked against 574 resolved markets, and the rule below
picked the winning bucket for 573 of them:

- Most cities: the max (or min) of the METAR reports, routine plus specials, at the named airport
  over the station's local calendar day, rounded to a whole degree. The source is NOAA's
  `weather.gov/wrh/timeseries`. Taipei is the same station data via Wunderground.
- Hong Kong: the Observatory's 0.1 °C daily extreme, **truncated** (33.6 → "33°C").
- Markets keep trading through the target day, well past Gamma's `endDate` (12:00 UTC on the day).
  They resolve a few hours after local midnight, and Hong Kong takes several days.

**Prediction engine** (`src/weather/model/`). It has several approaches, each scored per station
and lead time:

| Approach | What it is |
|---|---|
| Multi-model NWP | ECMWF IFS + AIFS, GFS/HRRR, ICON, GEM, JMA, Météo-France, UKMO, CMA, NBM (US), KNMI/MET Norway (Europe), via Open-Meteo. Each model is debiased per station, high/low and lead. Raw models run 1–2 °C cold on highs. |
| Blend | Skill-weighted mean of the debiased models, with its own learned error (≈1.0 °C the day before, which beats any single model). |
| Nowcast | On the day itself, the blend is pulled toward today's observed model error, more strongly close to the hour of the extreme. |
| Ensemble | ECMWF/GEFS/ICON-EPS members, debiased by their parent model, then dressed to the ensemble's learned error. |
| Observations | The running METAR or HKO extreme is a hard floor (highs) or ceiling (lows). Buckets it rules out are capped at 0.2%. |
| Market | The implied distribution from the order books, plus its 1–3 hour momentum. |

The Gaussian (blend or nowcast) and the ensemble are mixed with weights learned per lead time.
A calibrator, which is a learned logarithmic opinion pool, then blends the weather probability with
the market's, separately for the day itself and days before. Its weights show how much the
forecast deserves to be trusted over the crowd.

**Strategies.** Each gets a $1000 paper bankroll by default:

| id | Idea |
|---|---|
| `market-favorite` | Control. Buys the market's favourite the day before, with no model. |
| `nowcast-sniper` | Same day only. Buys near-certain sides once observations pin the outcome. |
| `forecast-taker` | Takes the blended probability when the edge after fees is at least 6¢. |
| `maker-bidder` | Rests the bid with the best fill-rate × edge instead of paying the spread and fee. |
| `tail-fader` | Buys NO on long-shot buckets the market overprices. |
| `model-only` | Uses the pure forecast and ignores the market price. Tests whether the weather model alone beats the crowd. |
| `learning` | Follows whichever proven shadow variant fits the current timing window. It's sized by Kelly × confidence × the city's learned multiplier, and sits out until a variant is proven. |

**Learning mode** (`WEATHER_LEARNING_MODE=true`, the default) has five parts:

- **Shadow variants.** 96 of them, covering probability source × edge threshold × timing window
  × side × taker/maker. Each paper-trades $1 bets, and each settled event is one sample.
- **Timing.** Returns are pooled by window (D-2, D-1, today with more than 6h left, today with
  less than 6h left).
- **Cities.** Pooled returns give each city a stake multiplier from 0 (avoid) to 2 (favour).
- **Best bid.** The maker fill rate is learned by distance below the ask.
- **Forecast skill.** It's seeded from 45 days of history: Open-Meteo previous runs against the
  IEM METAR archive, walk-forward. After that it's updated from every observed day.

Each lead bin's mixer and calibrator also update on every resolved event. Scoring is
prequential, meaning each prediction is scored before the system learns from it.

**Data safety.** An event is not tradeable when:

- forecasts are more than 3h old,
- same-day observations are more than 2h old,
- a finished day's observations have gaps,
- the station's history backfill hasn't finished, or
- the market has no usable quotes.

Fills walk real CLOB books with each market's fee schedule. NO books are mirrored from YES books;
on Polymarket they're the same book. Resting bids fill only when the ask trades through them.

Logs go to `logs/weather/`:

- `state.json`, `samples.json`: learning state; these survive restarts.
- `trades.csv`, `settlements.csv`: paper fills and settlements.
- `outcomes.csv`: observed extreme vs the official result.
- `snapshots/*.jsonl`: an hourly per-event model vs market record, about 9 MB/day.
  Turn it off with `WEATHER_RECORD_SNAPSHOTS=false`.

Settings are in `.env.example` under "Weather trader". Live trading is **not** wired for weather
yet. The report's go-live checklist is the bar to clear first.

Data sources are all free, with no keys. Open-Meteo's free tier is for non-commercial use, so set
`OPEN_METEO_API_KEY` for commercial use. The required outbound hosts are:

- `gamma-api.polymarket.com`, `clob.polymarket.com`
- `api.open-meteo.com`, `ensemble-api.open-meteo.com`, `previous-runs-api.open-meteo.com`
- `aviationweather.gov`, `mesonet.agron.iastate.edu`
- `data.weather.gov.hk`, `www.hko.gov.hk`

## Other-markets simulator (crypto ladders)

A second paper-trading process runs next to the BTC 5m bot for **crypto price ladders**:

- "Bitcoin above $X on <date>"
- "between $X and $Y"
- "reach $X in October"
- hourly and daily Up or Down markets

These cover BTC, ETH, SOL and XRP. They're priced off the Deribit options implied-vol surface,
falling back to Binance realized vol, and Binance spot.

Each loop discovers markets on Gamma and computes a model probability. It logs a calibration
snapshot, then paper-buys the YES/NO side whose ask plus taker fee sits at least `*_MIN_EDGE` below
the model. Fills walk the real CLOB book, and positions settle from Gamma resolutions.

```bash
npm run sim:markets                 # foreground
npm run pm2:start                   # runs btc-assistant + markets-sim + weather-sim + dashboard
npm run report:markets -- --hours 24
```

The report compares the markets after fees. It also scores the model against the market's own
price (Brier score) on resolved markets. If the model doesn't beat the market's Brier score, any
profit is luck.

- Logs go to `logs/markets_*.csv`.
- State goes to `logs/markets_state.json`, which survives restarts.
- The dashboard shows a "markets sim" panel.
- Settings are listed in `.env.example`.

Required outbound hosts: `gamma-api.polymarket.com`, `clob.polymarket.com`, `www.deribit.com` and
`api.binance.com`.

## Requirements

- Node.js 18+ (tested on 22)
- For running on a server under PM2, see [quickstart.md](quickstart.md)
