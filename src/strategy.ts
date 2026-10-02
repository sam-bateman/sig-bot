// Pure pricing logic. Everything is in integer ticks (1 tick = 0.005) and YES terms:
// a bid is a buy of YES, an ask is a sell of YES (placed as a buy of NO at 1 - ask).
import { MAX_TICK, MIN_TICK, TICKS_PER_UNIT } from './config.js';

export interface TickLevel {
  priceT: number;
  quantity: number;
}

export interface TickBook {
  bids: TickLevel[]; // best (highest) first
  asks: TickLevel[]; // best (lowest) first
}

export interface Touch {
  bidT: number;
  askT: number;
}

export interface QuoteParams {
  halfEdgeTicks: number;
  skewTicksPerShare: number;
}

export interface LegQuote {
  bidT: number | null;
  askT: number | null;
}

export const toTicks = (price: number) => Math.round(price * TICKS_PER_UNIT);
export const fromTicks = (t: number) => t / TICKS_PER_UNIT;

// Best bid and ask, skipping dust levels smaller than minQty.
export function touch(book: TickBook, minQty: number): Touch | null {
  const bid = book.bids.find((l) => l.quantity >= minQty);
  const ask = book.asks.find((l) => l.quantity >= minQty);
  if (!bid || !ask || bid.priceT >= ask.priceT) return null;
  return { bidT: bid.priceT, askT: ask.priceT };
}

// Fair value per leg. The legs are mutually exclusive, so their probabilities sum to at most 1,
// and at least 1 - otherMax (the chance no listed party wins). Each leg's mid is shifted by an
// equal share of the excess or shortfall.
export function fairValues(touches: Touch[], otherMaxTicks: number): number[] {
  const mids = touches.map((t) => (t.bidT + t.askT) / 2);
  const sum = mids.reduce((a, b) => a + b, 0);
  const target = Math.min(TICKS_PER_UNIT, Math.max(TICKS_PER_UNIT - otherMaxTicks, sum));
  const shift = (target - sum) / mids.length;
  return mids.map((m) => m + shift);
}

// Delta of each leg: how much more the book pays if that leg wins than on average across legs.
// Holding equal YES on every leg is flat, so only the differences carry risk.
export function raceDeltas(netYes: number[]): number[] {
  const mean = netYes.reduce((a, b) => a + b, 0) / netYes.length;
  return netYes.map((q) => q - mean);
}

// Quotes for one leg: fair value plus or minus the edge, shifted against inventory, never crossing
// the external book and never improving on it by more than one tick.
export function quoteLeg(fairT: number, t: Touch, delta: number, p: QuoteParams): LegQuote {
  const center = fairT - delta * p.skewTicksPerShare;
  let bidT = Math.floor(center - p.halfEdgeTicks + 1e-9);
  let askT = Math.ceil(center + p.halfEdgeTicks - 1e-9);
  bidT = Math.min(bidT, t.bidT + 1, t.askT - 1);
  askT = Math.max(askT, t.askT - 1, t.bidT + 1);
  // Our own bid and ask must never meet, or the second one self-trades.
  if (bidT >= askT) bidT = askT - 1;
  return {
    bidT: bidT >= MIN_TICK && bidT <= MAX_TICK ? bidT : null,
    askT: askT >= MIN_TICK && askT <= MAX_TICK ? askT : null,
  };
}

export interface ArbLeg {
  legIndex: number;
  side: 'bid' | 'ask'; // which YES side of the book we hit
  priceT: number; // YES price we trade at
}

export interface Arb {
  kind: 'sell-all' | 'buy-all';
  edgeTicks: number; // locked profit per share, in ticks
  quantity: number;
  legs: ArbLeg[];
}

// Locked-profit check across a race's external books.
// sell-all: the YES bids sum above 1, so selling YES on every leg (buying NO) costs n - sum(bids)
//   and pays at least n - 1, since at most one leg wins.
// buy-all: the YES asks sum below 1 - otherMax, so buying YES on every leg pays 1 whenever a
//   listed party wins.
export function findArb(books: TickBook[], otherMaxTicks: number, minEdgeTicks: number, maxShares: number): Arb | null {
  const bids = books.map((b) => b.bids[0]);
  const asks = books.map((b) => b.asks[0]);
  if (bids.every(Boolean)) {
    const edge = bids.reduce((a, l) => a + l!.priceT, 0) - TICKS_PER_UNIT;
    if (edge >= minEdgeTicks) {
      const quantity = Math.min(maxShares, ...bids.map((l) => l!.quantity));
      return { kind: 'sell-all', edgeTicks: edge, quantity, legs: bids.map((l, i) => ({ legIndex: i, side: 'bid', priceT: l!.priceT })) };
    }
  }
  if (asks.every(Boolean)) {
    const edge = TICKS_PER_UNIT - otherMaxTicks - asks.reduce((a, l) => a + l!.priceT, 0);
    if (edge >= minEdgeTicks) {
      const quantity = Math.min(maxShares, ...asks.map((l) => l!.quantity));
      return { kind: 'buy-all', edgeTicks: edge, quantity, legs: asks.map((l, i) => ({ legIndex: i, side: 'ask', priceT: l!.priceT })) };
    }
  }
  return null;
}

// Prefer contested races: the closer the favourite is to 50%, the more two-way flow.
export function raceScore(fairs: number[]): number {
  const top = Math.max(...fairs);
  return Math.abs(top - TICKS_PER_UNIT / 2);
}
