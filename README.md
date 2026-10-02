# sig-bot

Pair market maker for the Susquehanna Predictions Cup "Midterm Elections" tournament on the Super Market API. The bot trades in virtual currency ("SUSQies"; you start with 100,000, the tournament runs to 2026-11-04, and ranking is by P&L).

## The Edge

Each race (e.g. "Texas Senate") has separate "Republican wins" and "Democrat wins" markets, and some also have "Independent wins". At most one can win, so their prices should sum to about 1.00, but the platform doesn't enforce this.

The bot:
1. **Estimates fair value** from both legs together, shifting each leg's fair price so all mids sum within the allowed range for "no listed party wins" to occur.
2. **Rests quotes** a couple of ticks around fair on every leg. This earns the spread. Inventory skew shifts quotes against your positions—buying one leg is offset by selling the other—so you're naturally hedged.
3. **Takes locked-profit arbs**: when YES bids in a race sum above 1.00, buy NO on every leg. When YES asks sum below 1.00 minus a small allowance, buy YES on every leg.

There are no trading fees, so the edge is pure price discovery plus spread capture.

## Setup

Requires Node 22+. Clone, install, and configure:

```bash
npm install
```

Add to `.env` (gitignored):

```
SIG_API_KEY=<your-api-key>
```

Get the API key from Super Market API > My Profile > API Keys. It needs read and trade scopes.

## Commands

- `npm run scan` — Read-only: print the race table and check for arbs.
- `npm run bot` — Dry run: log what you would quote, place no orders.
- `npm run bot -- --live` — Live: trade for real.
- `npm run status` — Print your balance, positions, P&L, and leaderboard rank.
- `npm run kill` — Cancel every open order (emergency stop).
- `npm test` — Unit tests.
- `npm run typecheck` — TypeScript check.

## Configuration

All settings are environment variables. Read from `.env` if it exists. Defaults are shown.

| Name | Default | Meaning |
|------|---------|---------|
| `SIG_READS_PER_MIN` | 80 | Max reads per minute (account limit is 100, shared with other scripts) |
| `SIG_WRITES_PER_MIN` | 26 | Max writes per minute (account limit is 30, shared with other scripts) |
| `SIG_CYCLE_MS` | 5000 | Main loop interval (milliseconds) |
| `SIG_QUOTE_TTL_SEC` | 60 | Quote expiry (seconds) |
| `SIG_RECONCILE_MS` | 60000 | Reconciliation interval (milliseconds) |
| `SIG_MAX_RACES` | 20 | Max races to quote |
| `SIG_HALF_EDGE_TICKS` | 2 | Half-width of quotes around fair (in ticks; 1 tick = 0.005) |
| `SIG_QUOTE_SIZE` | 200 | Order size (shares per quote) |
| `SIG_SKEW_TICKS_PER_SHARE` | 0.0025 | Inventory skew sensitivity |
| `SIG_LEVEL_SKEW_TICKS_PER_SHARE` | 0.001 | Shift every leg's quotes against the race's average position (shares short or long on all legs) |
| `SIG_MIN_FAIR_LEVEL_QTY` | 50 | Ignore book levels smaller than this when computing fair |
| `SIG_MAX_FAIR_SPREAD_TICKS` | 12 | Skip race if any leg's external spread is wider |
| `SIG_OTHER_MAX_TICKS` | 4 | Probability mass allowed for "no listed party wins" (ticks) |
| `SIG_REQUOTE_THRESHOLD_TICKS` | 1 | Re-quote only when desired price moves by this many ticks |
| `SIG_MAX_LEG_SHARES` | 3000 | Max shares per leg |
| `SIG_MAX_RACE_DELTA` | 2000 | Max net exposure within a race |
| `SIG_MAX_RACE_LEVEL` | 2000 | Max average position across a race's legs (e.g. short on every leg) |
| `SIG_MAX_GROSS_COST` | 40000 | Max total cost across all positions |
| `SIG_ARB_MIN_EDGE_TICKS` | 1 | Min locked profit to take an arb (ticks) |
| `SIG_ARB_MAX_SHARES` | 2000 | Max shares per arb trade |
| `SIG_UNWIND_MAX_ASK_SUM_TICKS` | 200 | Buy back all-leg short sets when the YES asks sum to at most this (ticks) |
| `SIG_UNWIND_MIN_BID_SUM_TICKS` | 200 | Sell all-leg long sets when the YES bids sum to at least this (ticks) |
| `SIG_UNWIND_MAX_SHARES` | 5000 | Max sets per unwind |

## How It Works

**Book updates** come over a Supabase realtime feed. On gaps, the bot fetches the full book via REST. Your own orders are subtracted from the external book before computing fair value, so you don't trade against yourself.

**Quoting**: every cycle (default 5s), compute fair values and deltas for each race, check risk limits, and generate quotes. Quotes expire after 60 seconds, so they die if the bot crashes. To re-quote, cancel all orders in a market or tournament-wide (whichever costs fewer API writes) and place new ones. Orders batch up to 25 per write.

**Arbs** are executed as atomic multi-leg orders with a 5-second expiry. If the YES bids sum above 1.00, place bids on every leg to sell YES (buy NO). If the YES asks sum below the target, place asks on every leg to buy YES.

**Unwinds**: when the bot is short YES on every leg of a race and the YES asks sum to 1.00 or less, it buys the matched sets back in one atomic multi-leg order. The mirror image applies to long sets when the YES bids sum to 1.00 or more. That's no worse than holding to settlement, and it frees the capital.

**Reconciliation** runs every 60 seconds: fetch your orders and positions from the API, mark fills, update PnL, and resync any gaps in the book.

## Safety

**Dry run is the default.** Nothing is placed until you pass `--live`.

On Ctrl-C, the bot cancels all open orders, clears positions, and exits.

**Risk limits** are enforced before placing quotes:
- Max shares per leg
- Max race delta (net long or short within a race)
- Max race level (average position across legs, e.g. short YES on every leg)
- Max gross cost (sum of share qty × current price across all races)

**Rate limits** are per-account: 100 reads and 30 writes per minute, shared with every script you run. The bot defaults to 80 reads and 26 writes to leave headroom.

Emergency stop: `npm run kill`.

## Known Limitations

- The set of races is selected once at startup based on volume. It does not change if new races are added mid-tournament.
- The "no listed party wins" allowance is a global setting (`SIG_OTHER_MAX_TICKS`), not per-race.
- Fair value is the book midpoint only; no outside data or historical context yet.

## Layout

- `src/main.ts` — Entry point; initializes the engine and runs the main loop.
- `src/api.ts` — REST API client for Super Market API.
- `src/config.ts` — Configuration: environment variables with defaults.
- `src/engine.ts` — Core loop: books, orders, positions, re-quoting, arbs, reconciliation.
- `src/strategy.ts` — Pricing: fair value, quotes, inventory skew, arb detection.
- `src/universe.ts` — Race building: find mutually exclusive market pairs.
- `src/realtime.ts` — Supabase subscription: book updates, fills, resyncs.
- `src/books.ts` — Order book store: track bid/ask levels per exchange.
- `src/state.ts` — Orders and positions: track your own orders, compute deltas, exposures.
- `src/risk.ts` — Risk checks: max shares, max delta, max cost.
- `src/log.ts` — Logging.
- `src/scripts/scan.ts` — Race and arb scanner (read-only).
- `src/scripts/status.ts` — Print balance, positions, PnL, leaderboard.
- `src/scripts/kill.ts` — Cancel all open orders.
- `docs/openapi.json` — Super Market API spec.
