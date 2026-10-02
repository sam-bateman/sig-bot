// Our own resting orders and positions, kept current from order responses and the account feed,
// and reconciled against REST on a timer.
import type { Position, RestOrder } from './api.js';
import { TICKS_PER_UNIT } from './config.js';
import { toTicks, type TickBook } from './strategy.js';

export interface OwnOrder {
  id: string;
  exchangeId: string;
  side: 'bid' | 'ask'; // YES terms
  priceT: number; // YES ticks
  quantity: number;
  // Filled so far: the larger of what the placement response reported and what the feed has
  // delivered, since the feed later repeats fills that happened at placement.
  filled: number;
  feedFilled: number;
  placedAt: number; // ms epoch; 0 when learned from REST
  expiresAt: number; // ms epoch; Infinity when unknown
  kind: 'quote' | 'arb';
}

export const remaining = (o: OwnOrder) => o.quantity - o.filled;

export class OrderBookkeeper {
  readonly orders = new Map<string, OwnOrder>();

  add(o: OwnOrder) {
    if (remaining(o) > 0) this.orders.set(o.id, o);
  }

  fill(orderId: string, qty: number) {
    const o = this.orders.get(orderId);
    if (!o) return;
    o.feedFilled += qty;
    o.filled = Math.max(o.filled, o.feedFilled);
    if (remaining(o) <= 0) this.orders.delete(orderId);
  }

  remove(orderId: string) {
    this.orders.delete(orderId);
  }

  clear(exchangeIds?: Set<string>) {
    for (const [id, o] of this.orders) if (!exchangeIds || exchangeIds.has(o.exchangeId)) this.orders.delete(id);
  }

  prune(now: number) {
    for (const [id, o] of this.orders) if (o.expiresAt <= now) this.orders.delete(id);
  }

  forExchange(exchangeId: string): OwnOrder[] {
    return [...this.orders.values()].filter((o) => o.exchangeId === exchangeId);
  }

  // Replace our view with the server's open orders. For an open order the server's quantity is
  // what is still resting. Orders we placed after `keepPlacedAfter` survive even if the listing
  // doesn't show them yet.
  reconcile(rest: RestOrder[], keepPlacedAfter = Infinity) {
    const next = new Map<string, OwnOrder>();
    for (const r of rest) {
      if (!r.open || r.priceLimit === null) continue;
      const id = String(r.id);
      const known = this.orders.get(id);
      const yes = toYes(r.side, r.action, toTicks(r.priceLimit));
      next.set(id, {
        id,
        exchangeId: r.exchangeId,
        side: yes.side,
        priceT: yes.priceT,
        quantity: r.quantity,
        filled: 0,
        feedFilled: 0,
        placedAt: known?.placedAt ?? 0,
        expiresAt: r.expirationDate ? Date.parse(r.expirationDate) : Infinity,
        kind: known?.kind ?? 'quote',
      });
    }
    for (const [id, o] of this.orders) if (!next.has(id) && o.placedAt > keepPlacedAfter) next.set(id, o);
    this.orders.clear();
    for (const [id, o] of next) this.orders.set(id, o);
  }
}

// Convert an order's side/action/price into YES terms.
export function toYes(side: 'yes' | 'no', action: 'buy' | 'sell', priceT: number): { side: 'bid' | 'ask'; priceT: number } {
  const buysYes = (side === 'yes') === (action === 'buy');
  const yesPriceT = side === 'yes' ? priceT : TICKS_PER_UNIT - priceT;
  return { side: buysYes ? 'bid' : 'ask', priceT: yesPriceT };
}

export class Positions {
  readonly netYes = new Map<string, number>();
  costBasis = 0;

  get(exchangeId: string) {
    return this.netYes.get(exchangeId) ?? 0;
  }

  apply(exchangeId: string, side: 'bid' | 'ask', qty: number) {
    this.netYes.set(exchangeId, this.get(exchangeId) + (side === 'bid' ? qty : -qty));
  }

  reconcile(positions: Position[], totalCostBasis: number) {
    this.netYes.clear();
    for (const p of positions) {
      if (p.settled) continue;
      const net = p.lots.length
        ? p.lots.reduce((a, l) => a + (l.side.toLowerCase() === 'yes' ? l.quantity : -l.quantity), 0)
        : p.quantity;
      this.netYes.set(p.exchangeId, net);
    }
    this.costBasis = totalCostBasis;
  }
}

// The book as everyone else sees it: our own resting size removed from each level.
export function externalBook(book: TickBook, own: OwnOrder[]): TickBook {
  const minus = (levels: TickBook['bids'], side: 'bid' | 'ask') =>
    levels
      .map((l) => ({
        priceT: l.priceT,
        quantity: l.quantity - own.filter((o) => o.side === side && o.priceT === l.priceT).reduce((a, o) => a + remaining(o), 0),
      }))
      .filter((l) => l.quantity > 0);
  return { bids: minus(book.bids, 'bid'), asks: minus(book.asks, 'ask') };
}
