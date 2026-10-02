// Latest order book per exchange, versioned by the engine's asOf so stale pushes never win.
import type { AsOf, Level } from './api.js';
import { toTicks, type TickBook } from './strategy.js';

interface Held {
  book: TickBook;
  asOf: AsOf | null;
  nextExpiryAt: number | null;
  receivedAt: number;
}

export class BookStore {
  private readonly books = new Map<string, Held>();

  // Apply a book if it is newer than the one held. `force` is for authoritative REST resyncs.
  apply(
    exchangeId: string,
    raw: { bids: Level[]; asks: Level[] },
    asOf: AsOf | null,
    nextExpiryAt: string | null = null,
    force = false,
  ): boolean {
    const held = this.books.get(exchangeId);
    if (!force && held && !isNewer(asOf, held.asOf)) return false;
    this.books.set(exchangeId, {
      book: {
        bids: raw.bids.map((l) => ({ priceT: toTicks(l.price), quantity: l.quantity })),
        asks: raw.asks.map((l) => ({ priceT: toTicks(l.price), quantity: l.quantity })),
      },
      asOf,
      nextExpiryAt: nextExpiryAt ? Date.parse(nextExpiryAt) : null,
      receivedAt: Date.now(),
    });
    return true;
  }

  get(exchangeId: string): TickBook | undefined {
    return this.books.get(exchangeId)?.book;
  }

  // Exchanges whose book holds an order that has since expired; no event announces expiry.
  expired(now: number): string[] {
    const out: string[] = [];
    for (const [id, h] of this.books) if (h.nextExpiryAt !== null && h.nextExpiryAt <= now) out.push(id);
    return out;
  }

  clearExpiry(exchangeId: string) {
    const h = this.books.get(exchangeId);
    if (h) h.nextExpiryAt = null;
  }
}

// A held book with no version is replaced by any pushed one.
export function isNewer(incoming: AsOf | null, held: AsOf | null): boolean {
  if (!held) return true;
  if (!incoming) return false;
  if (incoming.sequence !== held.sequence) return incoming.sequence > held.sequence;
  return Date.parse(incoming.at) > Date.parse(held.at);
}
