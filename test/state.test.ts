import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookkeeper, placementFill, Placements, Positions, externalBook, remaining, toYes, type OwnOrder } from '../src/state.js';
import { maxOrderSize } from '../src/risk.js';
import type { Position, RestOrder } from '../src/api.js';

const order = (over: Partial<OwnOrder> = {}): OwnOrder => ({
  id: 'o1',
  exchangeId: 'ex1',
  side: 'bid',
  priceT: 100,
  quantity: 100,
  filled: 0,
  feedFilled: 0,
  placedAt: 0,
  expiresAt: Infinity,
  kind: 'quote',
  ...over,
});

const rest = (over: Partial<RestOrder> = {}): RestOrder => ({
  id: 1,
  exchangeId: 'ex1',
  side: 'yes',
  action: 'buy',
  quantity: 100,
  priceLimit: 0.5,
  open: true,
  expirationDate: null,
  ...over,
});

describe('toYes', () => {
  it('buy yes is a bid at the same price', () => {
    assert.deepEqual(toYes('yes', 'buy', 120), { side: 'bid', priceT: 120 });
  });

  it('sell yes is an ask at the same price', () => {
    assert.deepEqual(toYes('yes', 'sell', 120), { side: 'ask', priceT: 120 });
  });

  it('buy no at p is an ask at 200 - p', () => {
    assert.deepEqual(toYes('no', 'buy', 80), { side: 'ask', priceT: 120 });
  });

  it('sell no at p is a bid at 200 - p', () => {
    assert.deepEqual(toYes('no', 'sell', 80), { side: 'bid', priceT: 120 });
  });

  it('mirrors around 100 ticks', () => {
    assert.deepEqual(toYes('no', 'buy', 100), { side: 'ask', priceT: 100 });
    assert.deepEqual(toYes('no', 'buy', 1), { side: 'ask', priceT: 199 });
    assert.deepEqual(toYes('no', 'sell', 199), { side: 'bid', priceT: 1 });
  });
});

describe('remaining', () => {
  it('is quantity minus filled', () => {
    assert.equal(remaining(order({ quantity: 100, filled: 30 })), 70);
  });
});

describe('OrderBookkeeper add / fill', () => {
  it('stores an order with remaining size', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    assert.equal(b.orders.size, 1);
  });

  it('does not store an order that is already fully filled', () => {
    const b = new OrderBookkeeper();
    b.add(order({ filled: 100 }));
    assert.equal(b.orders.size, 0);
  });

  it('accumulates feed fills', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    b.fill('o1', 30);
    b.fill('o1', 20);
    const o = b.orders.get('o1')!;
    assert.equal(o.feedFilled, 50);
    assert.equal(o.filled, 50);
    assert.equal(remaining(o), 50);
  });

  it('removes the order when fully filled', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    b.fill('o1', 60);
    b.fill('o1', 40);
    assert.equal(b.orders.has('o1'), false);
  });

  it('removes the order on an overfill too', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    b.fill('o1', 150);
    assert.equal(b.orders.has('o1'), false);
  });

  it('does not double count a fill that happened at placement and is repeated by the feed', () => {
    const b = new OrderBookkeeper();
    b.add(order({ filled: 50 })); // placement response said 50 filled
    b.fill('o1', 50); // feed repeats the same 50
    const o = b.orders.get('o1')!;
    assert.equal(o.filled, 50);
    assert.equal(remaining(o), 50);
  });

  it('counts only feed fills beyond the placement fill', () => {
    const b = new OrderBookkeeper();
    b.add(order({ filled: 50 }));
    b.fill('o1', 30); // feedFilled 30 < filled 50 -> still 50
    assert.equal(b.orders.get('o1')!.filled, 50);
    b.fill('o1', 40); // feedFilled 70 > 50
    assert.equal(b.orders.get('o1')!.filled, 70);
    b.fill('o1', 30); // feedFilled 100 -> fully filled
    assert.equal(b.orders.has('o1'), false);
  });

  it('ignores fills for unknown orders', () => {
    const b = new OrderBookkeeper();
    b.fill('nope', 10);
    assert.equal(b.orders.size, 0);
  });

  it('remove drops an order', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    b.remove('o1');
    b.remove('missing');
    assert.equal(b.orders.size, 0);
  });
});

describe('OrderBookkeeper prune / clear / forExchange', () => {
  it('prunes orders whose expiresAt is at or before now', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: 'a', expiresAt: 1000 }));
    b.add(order({ id: 'b', expiresAt: 2000 }));
    b.add(order({ id: 'c', expiresAt: Infinity }));
    b.prune(1000);
    assert.deepEqual([...b.orders.keys()].sort(), ['b', 'c']);
    b.prune(1999);
    assert.deepEqual([...b.orders.keys()].sort(), ['b', 'c']);
    b.prune(2000);
    assert.deepEqual([...b.orders.keys()], ['c']);
  });

  it('clear with an exchange set removes only those exchanges', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: 'a', exchangeId: 'x' }));
    b.add(order({ id: 'b', exchangeId: 'y' }));
    b.add(order({ id: 'c', exchangeId: 'z' }));
    b.clear(new Set(['x', 'z']));
    assert.deepEqual([...b.orders.keys()], ['b']);
  });

  it('clear with no argument removes everything', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: 'a' }));
    b.add(order({ id: 'b' }));
    b.clear();
    assert.equal(b.orders.size, 0);
  });

  it('forExchange filters by exchange', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: 'a', exchangeId: 'x' }));
    b.add(order({ id: 'b', exchangeId: 'y' }));
    assert.deepEqual(b.forExchange('x').map((o) => o.id), ['a']);
    assert.deepEqual(b.forExchange('none'), []);
  });
});

describe('OrderBookkeeper.reconcile', () => {
  it('builds orders from REST, converting to YES terms', () => {
    const b = new OrderBookkeeper();
    b.reconcile([
      rest({ id: 1, side: 'yes', action: 'buy', priceLimit: 0.45 }),
      rest({ id: 2, side: 'no', action: 'buy', priceLimit: 0.4 }),
    ]);
    const o1 = b.orders.get('1')!;
    const o2 = b.orders.get('2')!;
    assert.deepEqual([o1.side, o1.priceT], ['bid', 90]);
    assert.deepEqual([o2.side, o2.priceT], ['ask', 120]);
    assert.equal(o1.kind, 'quote');
    assert.equal(o1.expiresAt, Infinity);
  });

  it('skips closed orders and orders with no price limit', () => {
    const b = new OrderBookkeeper();
    b.reconcile([rest({ id: 1, open: false }), rest({ id: 2, priceLimit: null }), rest({ id: 3 })]);
    assert.deepEqual([...b.orders.keys()], ['3']);
  });

  it('drops tracked orders the server no longer lists', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: '7' }));
    b.reconcile([rest({ id: 8 })]);
    assert.deepEqual([...b.orders.keys()], ['8']);
  });

  it('takes the resting size from REST but keeps the known kind', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: '5', quantity: 200, filled: 80, feedFilled: 60, kind: 'arb' }));
    b.reconcile([rest({ id: 5, quantity: 120, priceLimit: 0.5 })]);
    const o = b.orders.get('5')!;
    assert.equal(o.quantity, 120);
    assert.equal(o.filled, 0);
    assert.equal(o.kind, 'arb');
    assert.equal(remaining(o), 120);
  });

  it('keeps orders placed after the cutoff that the listing does not show yet', () => {
    const b = new OrderBookkeeper();
    b.add(order({ id: 'new', placedAt: 2_000 }));
    b.add(order({ id: 'old', placedAt: 500 }));
    b.reconcile([], 1_000);
    assert.deepEqual([...b.orders.keys()], ['new']);
  });

  it('uses REST quantity and zero filled for unknown orders', () => {
    const b = new OrderBookkeeper();
    b.reconcile([rest({ id: 9, quantity: 75 })]);
    const o = b.orders.get('9')!;
    assert.equal(o.quantity, 75);
    assert.equal(o.filled, 0);
    assert.equal(o.feedFilled, 0);
  });

  it('parses the expiration date', () => {
    const b = new OrderBookkeeper();
    b.reconcile([rest({ id: 1, expirationDate: '2026-10-02T02:20:34.0819381+00:00' })]);
    assert.equal(b.orders.get('1')!.expiresAt, Date.parse('2026-10-02T02:20:34.081Z'));
  });

  it('reconciling an empty list clears everything', () => {
    const b = new OrderBookkeeper();
    b.add(order());
    b.reconcile([]);
    assert.equal(b.orders.size, 0);
  });
});

describe('externalBook', () => {
  const book = {
    bids: [
      { priceT: 100, quantity: 300 },
      { priceT: 99, quantity: 50 },
    ],
    asks: [
      { priceT: 102, quantity: 80 },
      { priceT: 103, quantity: 40 },
    ],
  };

  it('returns the book unchanged with no own orders', () => {
    assert.deepEqual(externalBook(book, []), book);
  });

  it('subtracts own remaining size at the matching side and price', () => {
    const own = [order({ side: 'bid', priceT: 100, quantity: 100, filled: 20 })];
    const ext = externalBook(book, own);
    assert.deepEqual(ext.bids, [
      { priceT: 100, quantity: 220 },
      { priceT: 99, quantity: 50 },
    ]);
    assert.deepEqual(ext.asks, book.asks);
  });

  it('sums several own orders at the same level', () => {
    const own = [order({ id: 'a', side: 'ask', priceT: 102, quantity: 30 }), order({ id: 'b', side: 'ask', priceT: 102, quantity: 20 })];
    assert.deepEqual(externalBook(book, own).asks[0], { priceT: 102, quantity: 30 });
  });

  it('does not subtract an order at the same price on the other side', () => {
    const own = [order({ side: 'ask', priceT: 100, quantity: 100 })];
    assert.deepEqual(externalBook(book, own).bids[0], { priceT: 100, quantity: 300 });
  });

  it('does not subtract an order at a different price', () => {
    const own = [order({ side: 'bid', priceT: 98, quantity: 100 })];
    assert.deepEqual(externalBook(book, own), book);
  });

  it('drops levels that were entirely ours', () => {
    const own = [order({ side: 'bid', priceT: 99, quantity: 50 }), order({ id: 'b', side: 'ask', priceT: 102, quantity: 80 })];
    const ext = externalBook(book, own);
    assert.deepEqual(ext.bids, [{ priceT: 100, quantity: 300 }]);
    assert.deepEqual(ext.asks, [{ priceT: 103, quantity: 40 }]);
  });

  it('drops levels where our size exceeds the displayed size', () => {
    const own = [order({ side: 'bid', priceT: 99, quantity: 500 })];
    assert.deepEqual(externalBook(book, own).bids, [{ priceT: 100, quantity: 300 }]);
  });

  it('does not mutate the input book', () => {
    const copy = structuredClone(book);
    externalBook(book, [order({ side: 'bid', priceT: 100, quantity: 100 })]);
    assert.deepEqual(book, copy);
  });
});

describe('Positions', () => {
  const pos = (over: Partial<Position> = {}): Position => ({
    exchangeId: 'ex1',
    marketId: 'm1',
    marketTitle: 't',
    settled: false,
    quantity: 0,
    avgCost: 0,
    currentPrice: null,
    costBasis: 0,
    unrealizedPnl: 0,
    lots: [],
    ...over,
  });

  it('get defaults to zero', () => {
    assert.equal(new Positions().get('nope'), 0);
  });

  it('apply adds on bid and subtracts on ask', () => {
    const p = new Positions();
    p.apply('ex1', 'bid', 100);
    p.apply('ex1', 'ask', 30);
    p.apply('ex2', 'ask', 10);
    assert.equal(p.get('ex1'), 70);
    assert.equal(p.get('ex2'), -10);
  });

  it('reconcile nets lots: yes positive, no negative, case-insensitive', () => {
    const p = new Positions();
    p.reconcile(
      [
        pos({
          exchangeId: 'a',
          lots: [
            { side: 'yes', quantity: 100, entryPrice: 0.4 },
            { side: 'YES', quantity: 50, entryPrice: 0.5 },
            { side: 'no', quantity: 30, entryPrice: 0.6 },
          ],
        }),
        pos({ exchangeId: 'b', lots: [{ side: 'no', quantity: 80, entryPrice: 0.5 }] }),
      ],
      1234,
    );
    assert.equal(p.get('a'), 120);
    assert.equal(p.get('b'), -80);
    assert.equal(p.costBasis, 1234);
  });

  it('reconcile falls back to quantity when there are no lots', () => {
    const p = new Positions();
    p.reconcile([pos({ exchangeId: 'a', quantity: 42 })], 0);
    assert.equal(p.get('a'), 42);
  });

  it('reconcile skips settled positions', () => {
    const p = new Positions();
    p.reconcile([pos({ exchangeId: 'a', settled: true, quantity: 99, lots: [{ side: 'yes', quantity: 99, entryPrice: 0.5 }] })], 0);
    assert.equal(p.netYes.has('a'), false);
    assert.equal(p.get('a'), 0);
  });

  it('reconcile replaces earlier state rather than merging', () => {
    const p = new Positions();
    p.apply('old', 'bid', 500);
    p.reconcile([pos({ exchangeId: 'a', quantity: 1 })], 0);
    assert.equal(p.get('old'), 0);
    assert.equal(p.get('a'), 1);
  });

  it('lots that cancel out leave a flat position', () => {
    const p = new Positions();
    p.reconcile([pos({ exchangeId: 'a', lots: [{ side: 'yes', quantity: 10, entryPrice: 0.5 }, { side: 'no', quantity: 10, entryPrice: 0.5 }] })], 0);
    assert.equal(p.get('a'), 0);
  });
});

describe('Placements', () => {
  const none = () => false;
  const place = (ps: Placements, id: string | null, over: Partial<{ exchangeId: string; side: 'bid' | 'ask'; quantity: number; traded: number; at: number }> = {}) =>
    ps.record(id, { exchangeId: 'ex1', side: 'ask', quantity: 50, traded: 0, at: 1_000, ...over });

  it('credits a fill reported on placement once', () => {
    const ps = new Placements();
    assert.equal(place(ps, 'o1', { traded: 50 }), 50);
    // The feed later repeats the same fill.
    assert.equal(ps.feedFill('o1', 50), 0);
  });

  it('credits only the feed fills beyond what placement reported', () => {
    const ps = new Placements();
    place(ps, 'o1', { quantity: 100, traded: 30 });
    assert.equal(ps.feedFill('o1', 30), 0);
    assert.equal(ps.feedFill('o1', 50), 50);
    assert.equal(ps.feedFill('o1', 20), 20);
  });

  it('caps a placement credit at the order size', () => {
    const ps = new Placements();
    assert.equal(place(ps, 'o1', { traded: 80 }), 50);
    assert.equal(place(ps, 'o2', { traded: -5 }), 0);
  });

  it('ignores feed fills for orders it never saw', () => {
    assert.equal(new Placements().feedFill('nope', 10), 0);
  });

  it('counts orders that left the book uncredited, by exchange and side', () => {
    const ps = new Placements();
    place(ps, 'o1');
    place(ps, 'o2', { side: 'bid' });
    place(ps, 'o3', { exchangeId: 'ex2' });
    place(ps, null, { quantity: 20 });
    assert.equal(ps.unconfirmed('ex1', 'ask', none), 70);
    assert.equal(ps.unconfirmed('ex1', 'bid', none), 50);
    assert.equal(ps.unconfirmed('ex2', 'ask', none), 50);
  });

  it('does not count an order that is still resting', () => {
    const ps = new Placements();
    place(ps, 'o1');
    place(ps, 'o2');
    assert.equal(ps.unconfirmed('ex1', 'ask', (id) => id === 'o2'), 50);
  });

  it('does not count shares already credited', () => {
    const ps = new Placements();
    place(ps, 'o1', { traded: 50 });
    place(ps, 'o2', { traded: 20 });
    assert.equal(ps.unconfirmed('ex1', 'ask', none), 30);
  });

  it('stops counting placements a snapshot covers, but still attributes their feed fills', () => {
    const ps = new Placements();
    place(ps, 'o1', { at: 1_000 });
    place(ps, null, { at: 1_000 });
    place(ps, 'o2', { at: 5_000 });
    ps.confirm(2_000, 0);
    assert.equal(ps.unconfirmed('ex1', 'ask', none), 50);
    assert.equal(ps.get('o1')?.exchangeId, 'ex1');
    assert.equal(ps.feedFill('o1', 10), 10);
  });

  it('never moves the confirmation point backwards', () => {
    const ps = new Placements();
    place(ps, 'o1', { at: 3_000 });
    ps.confirm(5_000, 0);
    ps.confirm(2_000, 0);
    assert.equal(ps.unconfirmed('ex1', 'ask', none), 0);
  });

  it('forgets placements older than the cutoff', () => {
    const ps = new Placements();
    place(ps, 'o1', { at: 1_000 });
    ps.confirm(2_000, 1_500);
    assert.equal(ps.get('o1'), undefined);
  });

  // The overnight breach: an ask leg near its cap, every 50-share quote filling on placement, no
  // feed and no snapshot in between. Sizing must stop at the cap, not a quote per cycle past it.
  it('keeps a leg inside its cap when every quote fills and positions lag', () => {
    const limits = { maxLegShares: 3_000, maxRaceDelta: 1e9 };
    const ps = new Placements();
    const snapshotNet = -2_853; // what REST last said
    let net = snapshotNet; // what the engine credits locally
    let truth = snapshotNet; // what the exchange holds
    for (let cycle = 0; cycle < 12; cycle++) {
      const pending = ps.unconfirmed('ex1', 'ask', none);
      const size = Math.min(50, maxOrderSize('ask', [net, 0], [pending, 0], 0, limits));
      if (size < 1) break;
      truth -= size;
      net -= place(ps, `o${cycle}`, { quantity: size, traded: size, at: 10_000 + cycle });
    }
    assert.equal(truth, -3_000);
    assert.equal(net, truth);
  });

  it('keeps a leg inside its cap when quotes fill unseen after placement', () => {
    const limits = { maxLegShares: 3_000, maxRaceDelta: 1e9 };
    const ps = new Placements();
    const net = -2_853;
    let truth = net;
    for (let cycle = 0; cycle < 12; cycle++) {
      // Resting on placement, then picked off with no feed: it just disappears from our book.
      const size = Math.min(50, maxOrderSize('ask', [net, 0], [ps.unconfirmed('ex1', 'ask', none), 0], 0, limits));
      if (size < 1) break;
      truth -= size;
      place(ps, `o${cycle}`, { quantity: size, at: 10_000 + cycle });
    }
    assert.ok(truth >= -3_000, `leg reached ${truth}`);
  });
});

// Shapes copied from live responses on 2026-10-02.
describe('placementFill', () => {
  it('reads a resting batch quote with a negative remainingQuantity as unfilled', () => {
    assert.deepEqual(placementFill(500, { open: true, remainingQuantity: -500, quantityTraded: 0 }), { traded: 0, left: 500, consistent: true });
  });

  it('reads a fully filled order', () => {
    assert.deepEqual(placementFill(500, { open: false, remainingQuantity: 0, quantityTraded: 500 }), { traded: 500, left: 0, consistent: true });
  });

  it('reads a partial fill whichever sign remainingQuantity has', () => {
    assert.deepEqual(placementFill(500, { open: true, remainingQuantity: -300, quantityTraded: 200 }), { traded: 200, left: 300, consistent: true });
    assert.deepEqual(placementFill(500, { open: true, remainingQuantity: 300, quantityTraded: 200 }), { traded: 200, left: 300, consistent: true });
  });

  it('falls back to remainingQuantity when quantityTraded is missing', () => {
    assert.deepEqual(placementFill(500, { open: true, remainingQuantity: -500 }), { traded: 0, left: 500, consistent: true });
    assert.deepEqual(placementFill(500, { open: true, remainingQuantity: 100 }), { traded: 400, left: 100, consistent: true });
  });

  it('treats a bare response as resting and unfilled', () => {
    assert.deepEqual(placementFill(500, {}), { traded: 0, left: 500, consistent: true });
  });

  it('flags fields that disagree', () => {
    assert.equal(placementFill(500, { open: true, remainingQuantity: -500, quantityTraded: 200 }).consistent, false);
  });

  it('never credits more than the order size', () => {
    assert.equal(placementFill(500, { quantityTraded: 900 }).traded, 500);
  });
});
