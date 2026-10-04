# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js (ESM, Node 18+) console assistant and optional live-trading bot for Polymarket "Bitcoin Up or Down" short-window markets. Despite the repo name, the code currently targets **5-minute** windows (`CONFIG.candleWindowMinutes = 5`, default series `btc-up-or-down-5m` / id `10684`); the README still says 15m. No build step, no linter, no TypeScript.

## Commands

```bash
npm install
npm start                 # main bot + terminal UI (src/index.js)
npm run dashboard         # Express dashboard on DASHBOARD_PORT (default 3000), serves src/index.html
npm run test:trading      # node:test suite for the trading path (sets dummy env vars itself)
npm run report:sim        # summarize simulation CSVs; report:sim:24h limits to last 24h
node src/index.js --api-log [--limit N] [--trades-only]   # print logs/api.log as a table and exit
npm run pm2:start         # run bot + dashboard under PM2 (ecosystem.config.cjs)
npm run sim:weather       # weather (temperature markets) paper trader; dashboard at /weather.html
npm run report:weather    # weather leaderboard + learning summary + go-live checklist
npm run weather:backfill  # seed forecast skill from history (also runs automatically per new station)
node --test src/weather/weather.test.js   # weather suite (unit + mocked end-to-end)
```

Run a single test file directly with `node --test <file>`, but the trading test needs the env vars from the `test:trading` script (`ENABLE_LIVE_TRADING=true`, dummy `PRIVATE_KEY`, empty funder address). Filter within a file with `--test-name-pattern`.

Configuration is entirely env-driven (`.env` loaded via `dotenv/config`); `.env.example` is the authoritative, commented list of knobs. All env parsing lives in `src/config.js` as a single `CONFIG` object.

## Architecture

**Two processes that communicate only through files in `./logs/`** (paths are relative to cwd, so run from the repo root):

- `src/index.js` — the bot. A single `while (true)` loop in `main()` that ticks every `CONFIG.pollIntervalMs` (2s). Each tick gathers data, computes indicators/scores, renders the TUI, writes `logs/dashboard.json`, appends CSV logs, runs the scenario simulator, and possibly places a live order.
- `src/server.js` — the dashboard. Reads `logs/dashboard.json` and the CSVs (`trade_history.csv`, `live_trades_debug.csv`, `bid_decisions_outcomes.csv`, `sim_scenarios_rounds.csv`, …), resolves market outcomes via the Gamma API (cached in `outcome_resolution_cache.json`), and exposes `/api/*` endpoints.
- Dashboard → bot control is file-based: `POST /api/manual-bid` writes `logs/manual_bid_request.json` (consumed by the bot if it matches the current market slug, 180s TTL; optionally protected by `DASHBOARD_MANUAL_BID_SECRET`); `/api/sim-controls` and `/api/sim-reset` write `logs/sim_controls.json`, which the bot polls and applies. Changing a CSV column or JSON shape in the bot requires updating the server's readers too.

**Data sources (`src/data/`)** — each has an HTTP fetcher and/or a WebSocket stream with fallback: Polymarket Gamma/CLOB (market discovery, prices, order book), Polymarket live-data WS for the Chainlink BTC/USD "current price" (primary), on-chain Chainlink on Polygon via HTTP/WSS RPC (fallback), Binance spot klines + trade WS, Binance Futures (funding, OI, long/short, basis). `src/net/proxy.js` installs an undici global dispatcher and WS agents from `HTTPS_PROXY`/`ALL_PROXY`.

**Signal pipeline:**
1. `src/indicators/` — classic TA (Heiken Ashi, RSI, MACD, VWAP) plus `gpt*.js` "GPT indicators" (derivatives + Polymarket microstructure factors) aggregated by `gptIndicators.js`. `polySwingsStore.js` tracks Polymarket price swings over time.
2. `src/engines/` — `regime.js` (trend/chop), `probability.js` (`scoreDirection` → raw up prob, `applyTimeAwareness` shrinks toward 50% by time remaining), `edge.js` (model prob vs market price → `ENTER`/`WAIT`), `confidence.js` (final −100..100 score = TA + `CONFIDENCE_AUXILIARY_WEIGHT` × aux scores).
3. `src/trading/liveTradeGuards.js` — gating before a live bid: threshold (+`DOWN_SIDE_EXTRA_THRESHOLD` for DOWN), edge-engine agreement, min model edge, coin-flip price band, chop guard, circuit breaker, timing window (`TRADE_TIMING_SECONDS`), cooldown.
4. `src/trading/polymarketTrade.js` (`executeTradeIfEnabled`) → `polymarketRelayerClient.js` — CLOB orders via `@polymarket/clob-client`, signing with `PRIVATE_KEY` on behalf of the proxy/smart wallet `POLYMARKET_FUNDER_ADDRESS` (signature type 2 / GNOSIS_SAFE by default). Max bid price comes from `CONFIDENCE_MAX_BID_LADDER` or `MAX_BID_PRICE`.

**Simulation** — `ENABLE_LIVE_TRADING=false` (default) is simulation mode. `src/simulation/scenarioSimulator.js` runs three parallel paper strategies (optimistic / normal / cautious, derived from `RISK_APPETITE` ± `RISK_APPETITE_STEP`) each round and writes `logs/sim_scenarios_*.csv` and `sim_strategy_decisions.csv`.

## Conventions / gotchas

- Anything that logs errors or request payloads from the trading path must go through `src/logRedact.js` (`errorToRedactedLogString`, `sanitizeForLog`) so private keys and API creds never hit disk.
- CSV logs are appended via `appendCsvRow` in `src/utils.js`; headers are written once, so adding a column to an existing CSV needs a fresh file (or migration) to stay parseable by `server.js`.
- `src/index.js` is large (~1700 lines) and holds TUI rendering, market resolution, price-to-beat parsing, and decision telemetry alongside the main loop; search it rather than assuming logic lives in a module.
- `QUIET_CONSOLE=true` reduces TUI output (useful headless/over SSH). `quickstart.md` documents EC2 + PM2 deployment.

## Weather trader (`src/weather/`)

Separate process (`runner.js`, pm2 app `weather-sim`) paper-trading Polymarket daily high/low temperature markets in learning mode. All state and logs live in `WEATHER_LOG_DIR` (default `logs/weather/`); `server.js` exposes them at `/api/weather*` and `src/weather.html`.

- Pipeline per 30s tick: `events.js` (Gamma, tag `daily-temperature`) → `sources/` (METAR, HKO, Open-Meteo, IEM) → `model/forecast.js` (per-model debias, blend, nowcast, ensemble, obs floor/ceiling) → `model/market.js` → `model/calibrator.js` (log opinion pool of model vs market) → `engine.js` (strategies + 96 shadow variants, fills, settlement) → learners in `strategy/learning.js` and `model/skill.js`.
- Resolution facts the code depends on: METAR stations round the local-day extreme of routine+special reports; Hong Kong (HKO) truncates 0.1 °C values (`rule: "floor"`); markets trade past Gamma `endDate` through the target day, so discovery uses `end_date_min = now − 4 days`, never `now`.
- NO order books are derived from YES books (`mirrorBook`); only YES books are fetched.
- aviationweather.gov truncates responses at 400 reports — `fetchMetars` splits batches; don't raise batch sizes for deep (30h) polls.
- Skill errors are stored in °C (°F ÷ 1.8) so stations pool; `forecast.js` converts back with `fromC`.
- Stations without history stay untradeable (`awaiting_backfill`) until backfilled or 40 live samples exist — raw models are 1–2 °C cold-biased on highs.
- Learning samples are one per *event*, not per bet (buckets of an event share one outcome).

