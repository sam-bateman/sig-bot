import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; add it to .env`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

// Prices are handled in integer ticks: 1 tick = 0.005, so 200 ticks = 1.00.
export const TICKS_PER_UNIT = 200;
export const MIN_TICK = 1;
export const MAX_TICK = 199;

export const config = {
  apiKey: required('SIG_API_KEY'),
  baseUrl: process.env.SIG_BASE_URL ?? 'https://sig.thesuper.market/api/v1',
  tournamentSlug: process.env.SIG_TOURNAMENT ?? 'midterm-elections',
  live: process.argv.includes('--live'),

  limits: {
    // Account budget is 100 reads / 30 writes per minute, shared by every key and script.
    readsPerMin: num('SIG_READS_PER_MIN', 80),
    writesPerMin: num('SIG_WRITES_PER_MIN', 26),
  },

  timing: {
    cycleMs: num('SIG_CYCLE_MS', 5_000),
    quoteTtlSec: num('SIG_QUOTE_TTL_SEC', 60),
    reconcileMs: num('SIG_RECONCILE_MS', 60_000),
    tokenRefreshMs: 150 * 60_000,
    maxResyncsPerCycle: 6,
  },

  strategy: {
    maxRaces: num('SIG_MAX_RACES', 20),
    // Quote half-width around fair value, in ticks.
    halfEdgeTicks: num('SIG_HALF_EDGE_TICKS', 2),
    quoteSize: num('SIG_QUOTE_SIZE', 200),
    // Ticks to shift a leg's quotes per share of race delta (inventory skew).
    skewTicksPerShare: num('SIG_SKEW_TICKS_PER_SHARE', 1 / 400),
    // Levels smaller than this are ignored when reading the touch for fair value.
    minFairLevelQty: num('SIG_MIN_FAIR_LEVEL_QTY', 50),
    // Skip a race when any leg's external spread is wider than this.
    maxFairSpreadTicks: num('SIG_MAX_FAIR_SPREAD_TICKS', 12),
    // Probability mass allowed for "no listed party wins", in ticks.
    otherMaxTicks: num('SIG_OTHER_MAX_TICKS', 4),
    // Re-quote only when the desired price moves by at least this many ticks.
    requoteThresholdTicks: num('SIG_REQUOTE_THRESHOLD_TICKS', 1),
  },

  risk: {
    maxLegShares: num('SIG_MAX_LEG_SHARES', 3_000),
    maxRaceDelta: num('SIG_MAX_RACE_DELTA', 2_000),
    maxGrossCost: num('SIG_MAX_GROSS_COST', 40_000),
  },

  arb: {
    minEdgeTicks: num('SIG_ARB_MIN_EDGE_TICKS', 1),
    maxShares: num('SIG_ARB_MAX_SHARES', 2_000),
    minShares: num('SIG_ARB_MIN_SHARES', 20),
    // Minimum locked profit per arb, in SUSQies.
    minProfit: num('SIG_ARB_MIN_PROFIT', 1),
    ttlSec: 5,
  },
};

export type Config = typeof config;
