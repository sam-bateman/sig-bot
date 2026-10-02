import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findArb,
  fairValues,
  findSnipes,
  fromTicks,
  impliedBand,
  quoteLeg,
  raceDeltas,
  raceLevel,
  raceScore,
  toTicks,
  touch,
  type TickBook,
  type Touch,
} from '../src/strategy.js';

const book = (bids: [number, number][], asks: [number, number][]): TickBook => ({
  bids: bids.map(([priceT, quantity]) => ({ priceT, quantity })),
  asks: asks.map(([priceT, quantity]) => ({ priceT, quantity })),
});

describe('toTicks / fromTicks', () => {
  it('converts known prices', () => {
    assert.equal(toTicks(0), 0);
    assert.equal(toTicks(0.005), 1);
    assert.equal(toTicks(0.5), 100);
    assert.equal(toTicks(1), 200);
    assert.equal(fromTicks(1), 0.005);
    assert.equal(fromTicks(200), 1);
  });

  it('handles float edge cases', () => {
    assert.equal(toTicks(0.09), 18);
    assert.equal(toTicks(0.995), 199);
    assert.equal(toTicks(0.015), 3);
    assert.equal(toTicks(0.035), 7);
    assert.equal(toTicks(0.285), 57);
  });

  it('round-trips every tick', () => {
    for (let t = 0; t <= 200; t++) {
      assert.equal(toTicks(fromTicks(t)), t, `tick ${t}`);
    }
  });

  it('round-trips every tick through a decimal string', () => {
    for (let t = 0; t <= 200; t++) {
      const price = Number(fromTicks(t).toFixed(3));
      assert.equal(toTicks(price), t, `tick ${t}`);
    }
  });
});

describe('touch', () => {
  it('returns best bid and ask', () => {
    assert.deepEqual(touch(book([[90, 100], [89, 100]], [[92, 100], [93, 100]]), 50), { bidT: 90, askT: 92 });
  });

  it('skips dust levels below minQty', () => {
    const b = book([[91, 5], [90, 100]], [[92, 10], [93, 60]]);
    assert.deepEqual(touch(b, 50), { bidT: 90, askT: 93 });
  });

  it('accepts a level exactly at minQty', () => {
    assert.deepEqual(touch(book([[90, 50]], [[92, 50]]), 50), { bidT: 90, askT: 92 });
  });

  it('returns null when one side is empty or all dust', () => {
    assert.equal(touch(book([], [[92, 100]]), 1), null);
    assert.equal(touch(book([[90, 100]], []), 1), null);
    assert.equal(touch(book([], []), 1), null);
    assert.equal(touch(book([[90, 10]], [[92, 100]]), 50), null);
  });

  it('returns null on crossed or locked books', () => {
    assert.equal(touch(book([[92, 100]], [[90, 100]]), 1), null);
    assert.equal(touch(book([[92, 100]], [[92, 100]]), 1), null);
  });

  it('is null when skipping dust uncovers a crossed book', () => {
    // After dropping dust the best bid (95) is above the best ask (93).
    assert.equal(touch(book([[95, 100]], [[90, 5], [93, 100]]), 50), null);
  });
});

describe('fairValues', () => {
  it('leaves the mids alone when the sum is within [200 - otherMax, 200]', () => {
    // mids 100 and 98 -> sum 198, otherMax 4 -> floor 196, so unchanged
    const f = fairValues([{ bidT: 99, askT: 101 }, { bidT: 97, askT: 99 }], 4);
    assert.deepEqual(f, [100, 98]);
  });

  it('accepts a sum exactly at either boundary unchanged', () => {
    assert.deepEqual(fairValues([{ bidT: 99, askT: 101 }, { bidT: 99, askT: 101 }], 4), [100, 100]);
    assert.deepEqual(fairValues([{ bidT: 97, askT: 99 }, { bidT: 97, askT: 99 }], 4), [98, 98]);
  });

  it('shifts down to exactly 200 when the sum is over', () => {
    // mids 110 + 100 = 210; shift -5 each
    const f = fairValues([{ bidT: 109, askT: 111 }, { bidT: 99, askT: 101 }], 4);
    assert.deepEqual(f, [105, 95]);
    assert.equal(f[0]! + f[1]!, 200);
  });

  it('shifts up to 200 - otherMax when the sum is under', () => {
    // mids 90 + 90 = 180 < 196; shift +8 each
    const f = fairValues([{ bidT: 89, askT: 91 }, { bidT: 89, askT: 91 }], 4);
    assert.deepEqual(f, [98, 98]);
    assert.equal(f[0]! + f[1]!, 196);
  });

  it('splits the shift equally across three legs', () => {
    // mids 90, 80, 70 -> sum 240; shift -40/3 each
    const touches: Touch[] = [
      { bidT: 89, askT: 91 },
      { bidT: 79, askT: 81 },
      { bidT: 69, askT: 71 },
    ];
    const f = fairValues(touches, 4);
    const shift = -40 / 3;
    assert.ok(Math.abs(f[0]! - (90 + shift)) < 1e-9);
    assert.ok(Math.abs(f[1]! - (80 + shift)) < 1e-9);
    assert.ok(Math.abs(f[2]! - (70 + shift)) < 1e-9);
    assert.ok(Math.abs(f[0]! + f[1]! + f[2]! - 200) < 1e-9);
  });

  it('three legs under the floor shift up equally', () => {
    // mids 50 each -> 150; floor 196; shift +46/3 each
    const t: Touch = { bidT: 49, askT: 51 };
    const f = fairValues([t, t, t], 4);
    for (const v of f) assert.ok(Math.abs(v - (50 + 46 / 3)) < 1e-9);
  });

  it('preserves the differences between legs', () => {
    const f = fairValues([{ bidT: 109, askT: 111 }, { bidT: 79, askT: 81 }, { bidT: 59, askT: 61 }], 4);
    assert.ok(Math.abs(f[0]! - f[1]! - 30) < 1e-9);
    assert.ok(Math.abs(f[1]! - f[2]! - 20) < 1e-9);
  });

  it('with otherMax 0 pins the sum to exactly 200', () => {
    const f = fairValues([{ bidT: 89, askT: 91 }, { bidT: 89, askT: 91 }], 0);
    assert.deepEqual(f, [100, 100]);
  });
});

describe('raceDeltas', () => {
  it('is zero when every leg holds the same position', () => {
    assert.deepEqual(raceDeltas([100, 100, 100]), [0, 0, 0]);
    assert.deepEqual(raceDeltas([0, 0]), [0, 0]);
  });

  it('measures each leg against the mean', () => {
    assert.deepEqual(raceDeltas([100, 0]), [50, -50]);
    assert.deepEqual(raceDeltas([90, 0, 0]), [60, -30, -30]);
  });

  it('always sums to zero', () => {
    const d = raceDeltas([13, -7, 40]);
    assert.ok(Math.abs(d.reduce((a, b) => a + b, 0)) < 1e-9);
  });

  it('is invariant to adding the same amount to every leg', () => {
    assert.deepEqual(raceDeltas([110, 10, 10]), raceDeltas([100, 0, 0]));
  });
});

describe('raceLevel', () => {
  it('is the mean of the legs', () => {
    assert.equal(raceLevel([100, -40]), 30);
    assert.equal(raceLevel([-30, -30, -30]), -30);
    assert.equal(raceLevel([90, 0, 0]), 30);
  });

  it('is zero when flat', () => {
    assert.equal(raceLevel([0, 0]), 0);
    assert.equal(raceLevel([0, 0, 0]), 0);
  });
});

describe('quoteLeg', () => {
  const params = { halfEdgeTicks: 2, skewTicksPerShare: 1 / 400 };

  it('quotes fair +/- the half edge when inside the touch limits', () => {
    // wide touch 90/110, fair 100: bid 98 (<= bidT+1 = 91?) -> clamped to bidT+1 = 91
    const q = quoteLeg(100, { bidT: 90, askT: 110 }, 0, params);
    assert.deepEqual(q, { bidT: 91, askT: 109 });
  });

  it('uses fair +/- edge when that is already tighter than the clamp', () => {
    // touch 99/101, fair 100, edge 2 -> raw 98/102; clamp bid <= 100, ask >= 100 -> 98/102
    const q = quoteLeg(100, { bidT: 99, askT: 101 }, 0, params);
    assert.deepEqual(q, { bidT: 98, askT: 102 });
  });

  it('never crosses the touch and never improves it by more than a tick', () => {
    for (let bidT = 5; bidT <= 190; bidT += 7) {
      for (const width of [1, 2, 3, 6, 15]) {
        const askT = bidT + width;
        if (askT > 195) continue;
        for (const fair of [bidT - 10, bidT, bidT + width / 2, askT, askT + 10]) {
          for (const delta of [-1000, -50, 0, 50, 1000]) {
            for (const halfEdgeTicks of [0, 0.5, 1, 2, 5]) {
              for (const level of [-5000, -300, 0, 300, 5000]) {
                const q = quoteLeg(fair, { bidT, askT }, delta, { halfEdgeTicks, skewTicksPerShare: 1 / 400, levelSkewTicksPerShare: 1 / 1000 }, level);
                const ctx = JSON.stringify({ bidT, askT, fair, delta, halfEdgeTicks, level, q });
                if (q.bidT !== null) {
                  assert.ok(q.bidT <= askT - 1, `bid crosses ask: ${ctx}`);
                  assert.ok(q.bidT <= bidT + 1, `bid improves by >1 tick: ${ctx}`);
                }
                if (q.askT !== null) {
                  assert.ok(q.askT >= bidT + 1, `ask crosses bid: ${ctx}`);
                  assert.ok(q.askT >= askT - 1, `ask improves by >1 tick: ${ctx}`);
                }
                if (q.bidT !== null && q.askT !== null) assert.ok(q.bidT < q.askT, `own quotes meet: ${ctx}`);
              }
            }
          }
        }
      }
    }
  });

  it('positive delta (long) never raises either quote, short never lowers', () => {
    const t = { bidT: 50, askT: 150 };
    const p = { halfEdgeTicks: 10, skewTicksPerShare: 0.5 };
    const flat = quoteLeg(100, t, 0, p);
    const long = quoteLeg(100, t, 8, p);
    const short = quoteLeg(100, t, -8, p);
    assert.deepEqual(flat, { bidT: 51, askT: 149 }); // both clamped to one tick inside the touch
    assert.ok(long.bidT! <= flat.bidT! && long.askT! <= flat.askT!);
    assert.ok(short.bidT! >= flat.bidT! && short.askT! >= flat.askT!);
  });

  it('positive delta lowers both quotes strictly when clamps do not bind', () => {
    // Touch brackets fair tightly enough that clamps do not bind: bid raw < bidT+1 and ask raw > askT-1.
    const t = { bidT: 95, askT: 105 };
    const p = { halfEdgeTicks: 6, skewTicksPerShare: 0.5 };
    const flat = quoteLeg(100, t, 0, p); // raw 94/106 -> bid 94, ask 106
    const long = quoteLeg(100, t, 4, p); // center 98 -> 92/104
    const short = quoteLeg(100, t, -4, p); // center 102 -> 96/108 -> bid clamped to 96
    assert.deepEqual(flat, { bidT: 94, askT: 106 });
    assert.deepEqual(long, { bidT: 92, askT: 104 });
    assert.ok(short.bidT! > flat.bidT! && short.askT! > flat.askT!);
  });

  it('short level raises both quotes, long level lowers them', () => {
    const t = { bidT: 95, askT: 105 };
    const p = { halfEdgeTicks: 6, skewTicksPerShare: 0.5, levelSkewTicksPerShare: 0.01 };
    const flat = quoteLeg(100, t, 0, p, 0); // 94/106
    const short = quoteLeg(100, t, 0, p, -200); // center 102 -> 96/108
    const long = quoteLeg(100, t, 0, p, 200); // center 98 -> 92/104
    assert.deepEqual(flat, { bidT: 94, askT: 106 });
    assert.deepEqual(short, { bidT: 96, askT: 108 });
    assert.deepEqual(long, { bidT: 92, askT: 104 });
  });

  it('ignores the level when levelSkewTicksPerShare is missing or 0', () => {
    const t = { bidT: 95, askT: 105 };
    const base = { halfEdgeTicks: 6, skewTicksPerShare: 0.5 };
    const flat = quoteLeg(100, t, 0, base);
    assert.deepEqual(quoteLeg(100, t, 0, base, -200), flat);
    assert.deepEqual(quoteLeg(100, t, 0, { ...base, levelSkewTicksPerShare: 0 }, 200), flat);
  });

  it('level skew and delta skew add up', () => {
    const t = { bidT: 95, askT: 105 };
    const p = { halfEdgeTicks: 6, skewTicksPerShare: 0.5, levelSkewTicksPerShare: 0.01 };
    // center = 100 - 4 * 0.5 - (-300) * 0.01 = 101 -> 95/107
    assert.deepEqual(quoteLeg(100, t, 4, p, -300), { bidT: 95, askT: 107 });
  });

  it('floors the bid and ceils the ask on fractional fair values', () => {
    const q = quoteLeg(100.4, { bidT: 90, askT: 110 }, 0, { halfEdgeTicks: 20, skewTicksPerShare: 0 });
    // raw bid floor(80.4)=80 -> min(80, 91, 109)=80 ; raw ask ceil(120.4)=121 -> max(121, 109, 91)=121
    assert.deepEqual(q, { bidT: 80, askT: 121 });
  });

  it('does not lose a tick to float error when fair +/- edge is an exact integer', () => {
    // 0.1 + 0.2 style noise: fair is 100.00000000000001, edge 20 -> bid must still be 80 not 79, ask 120 not 121
    const fair = 100 + 1e-12;
    const q = quoteLeg(fair, { bidT: 79, askT: 121 }, 0, { halfEdgeTicks: 20, skewTicksPerShare: 0 });
    assert.deepEqual(q, { bidT: 80, askT: 120 });
    const q2 = quoteLeg(100 - 1e-12, { bidT: 79, askT: 121 }, 0, { halfEdgeTicks: 20, skewTicksPerShare: 0 });
    assert.deepEqual(q2, { bidT: 80, askT: 120 });
  });

  it('own bid stays below own ask whenever the half edge is at least one tick', () => {
    for (let bidT = 5; bidT <= 190; bidT += 5) {
      for (const width of [1, 2, 3, 10]) {
        const askT = bidT + width;
        for (const fair of [bidT, bidT + width / 2, askT]) {
          for (const delta of [-500, 0, 500]) {
            const q = quoteLeg(fair, { bidT, askT }, delta, params);
            if (q.bidT !== null && q.askT !== null) {
              assert.ok(q.bidT < q.askT, JSON.stringify({ bidT, askT, fair, delta, q }));
            }
          }
        }
      }
    }
  });

  it('handles a one-tick-wide touch by quoting at or outside it', () => {
    const q = quoteLeg(100, { bidT: 100, askT: 101 }, 0, { halfEdgeTicks: 0, skewTicksPerShare: 0 });
    // bid <= askT-1 = 100, ask >= bidT+1 = 101
    assert.equal(q.bidT, 100);
    assert.equal(q.askT, 101);
  });

  it('one-tick-wide touch with a wide edge stays outside the touch', () => {
    const q = quoteLeg(100.5, { bidT: 100, askT: 101 }, 0, params);
    assert.deepEqual(q, { bidT: 98, askT: 103 });
  });

  it('returns null bid below 1 and null ask above 199', () => {
    const low = quoteLeg(2, { bidT: 1, askT: 3 }, 0, params);
    assert.equal(low.bidT, null); // floor(0) = 0
    assert.notEqual(low.askT, null);
    const high = quoteLeg(198, { bidT: 197, askT: 199 }, 0, params);
    assert.equal(high.askT, null); // ceil(200) = 200
    assert.notEqual(high.bidT, null);
  });

  it('keeps quotes at the exact limits 1 and 199', () => {
    const lo = quoteLeg(3, { bidT: 1, askT: 5 }, 0, { halfEdgeTicks: 2, skewTicksPerShare: 0 });
    assert.equal(lo.bidT, 1);
    const hi = quoteLeg(197, { bidT: 195, askT: 199 }, 0, { halfEdgeTicks: 2, skewTicksPerShare: 0 });
    assert.equal(hi.askT, 199);
  });

  it('huge skew pushes the bid out of range as null while the ask stays valid', () => {
    const q = quoteLeg(100, { bidT: 99, askT: 101 }, 1_000_000, params);
    assert.equal(q.bidT, null); // center is hugely negative; bid is only clamped from above
    assert.equal(q.askT, 100); // ask never drops below bidT + 1
  });
});

describe('findArb', () => {
  it('finds nothing on a normal book', () => {
    const books = [book([[99, 100]], [[101, 100]]), book([[97, 100]], [[99, 100]])];
    assert.equal(findArb(books, 4, 1, 1000), null);
  });

  it('detects sell-all when top bids sum above 200 by minEdge', () => {
    const books = [book([[105, 300]], [[110, 100]]), book([[98, 500]], [[110, 100]])];
    const arb = findArb(books, 4, 1, 1000);
    assert.ok(arb);
    assert.equal(arb.kind, 'sell-all');
    assert.equal(arb.edgeTicks, 3);
    assert.equal(arb.quantity, 300);
    assert.deepEqual(arb.legs, [
      { legIndex: 0, side: 'bid', priceT: 105 },
      { legIndex: 1, side: 'bid', priceT: 98 },
    ]);
  });

  it('caps the quantity at maxShares', () => {
    const books = [book([[105, 3000]], [[110, 100]]), book([[98, 5000]], [[110, 100]])];
    assert.equal(findArb(books, 4, 1, 250)!.quantity, 250);
  });

  it('requires the edge to be at least minEdge', () => {
    const books = [book([[101, 100]], [[110, 100]]), book([[100, 100]], [[110, 100]])]; // edge 1
    assert.ok(findArb(books, 4, 1, 100));
    assert.equal(findArb(books, 4, 2, 100), null);
  });

  it('treats a sum of exactly 200 as no edge when minEdge >= 1', () => {
    const books = [book([[100, 100]], [[110, 100]]), book([[100, 100]], [[110, 100]])];
    assert.equal(findArb(books, 4, 1, 100), null);
  });

  it('supports three legs for sell-all', () => {
    const books = [book([[90, 40]], [[95, 1]]), book([[70, 60]], [[95, 1]]), book([[42, 80]], [[95, 1]])];
    const arb = findArb(books, 4, 1, 1000)!;
    assert.equal(arb.kind, 'sell-all');
    assert.equal(arb.edgeTicks, 2);
    assert.equal(arb.quantity, 40);
    assert.equal(arb.legs.length, 3);
  });

  it('detects buy-all when 200 - otherMax - sum(asks) >= minEdge', () => {
    // asks 90 + 100 = 190; 200 - 4 - 190 = 6
    const books = [book([[80, 10]], [[90, 200]]), book([[80, 10]], [[100, 120]])];
    const arb = findArb(books, 4, 1, 1000);
    assert.ok(arb);
    assert.equal(arb.kind, 'buy-all');
    assert.equal(arb.edgeTicks, 6);
    assert.equal(arb.quantity, 120);
    assert.deepEqual(arb.legs, [
      { legIndex: 0, side: 'ask', priceT: 90 },
      { legIndex: 1, side: 'ask', priceT: 100 },
    ]);
  });

  it('buy-all edge at otherMax boundary', () => {
    const books = [book([[80, 10]], [[95, 900]]), book([[80, 10]], [[100, 900]])]; // sum 195
    const arb = findArb(books, 4, 1, 50);
    assert.ok(arb);
    assert.equal(arb.edgeTicks, 1);
    assert.equal(arb.quantity, 50);
    assert.equal(findArb(books, 5, 1, 50), null);
    assert.equal(findArb(books, 0, 5, 50)!.edgeTicks, 5);
  });

  it('returns null when a leg has no bids (sell-all) or no asks (buy-all)', () => {
    const rich = book([[120, 100]], [[130, 100]]);
    const emptyBids = book([], [[130, 100]]);
    assert.equal(findArb([rich, emptyBids], 4, 1, 100), null);
    const cheap = book([[10, 100]], [[20, 100]]);
    const emptyAsks = book([[10, 100]], []);
    assert.equal(findArb([cheap, emptyAsks], 4, 1, 100), null);
  });

  it('can still find buy-all when only the sell-all side is missing data', () => {
    const a = book([], [[50, 100]]);
    const b = book([[10, 100]], [[60, 70]]);
    const arb = findArb([a, b], 4, 1, 1000)!;
    assert.equal(arb.kind, 'buy-all');
    assert.equal(arb.quantity, 70);
  });

  it('returns null for books with no data at all', () => {
    assert.equal(findArb([book([], []), book([], [])], 4, 1, 100), null);
  });
});

describe('raceScore', () => {
  it('is zero when the favourite is at 50%', () => {
    assert.equal(raceScore([100, 96]), 0);
  });

  it('grows as the favourite moves away from 50%', () => {
    assert.equal(raceScore([150, 46]), 50);
    assert.equal(raceScore([20, 10]), 80);
  });

  it('ranks contested races below (lower score) lopsided ones', () => {
    assert.ok(raceScore([105, 90]) < raceScore([180, 10]));
  });

  it('uses the top leg regardless of order', () => {
    assert.equal(raceScore([30, 130, 30]), raceScore([130, 30, 30]));
  });
});

describe('impliedBand', () => {
  it('computes band for a single other leg with otherMax 0', () => {
    const band = impliedBand([100], 0);
    assert.deepEqual(band, { loT: 100, hiT: 100 });
  });

  it('computes band for a single other leg with otherMax 4', () => {
    const band = impliedBand([100], 4);
    assert.deepEqual(band, { loT: 96, hiT: 100 });
  });

  it('computes band for two other legs summing to 180, otherMax 0', () => {
    const band = impliedBand([90, 90], 0);
    assert.deepEqual(band, { loT: 20, hiT: 20 });
  });

  it('computes band for two other legs summing to 180, otherMax 4', () => {
    const band = impliedBand([90, 90], 4);
    assert.deepEqual(band, { loT: 16, hiT: 20 });
  });

  it('handles empty otherFairs', () => {
    const band = impliedBand([], 0);
    assert.deepEqual(band, { loT: 200, hiT: 200 });
  });

  it('handles empty otherFairs with otherMax 4', () => {
    const band = impliedBand([], 4);
    assert.deepEqual(band, { loT: 196, hiT: 200 });
  });

  it('computes band for two legs with different values: 100 + 50 = 150, otherMax 4', () => {
    const band = impliedBand([100, 50], 4);
    assert.deepEqual(band, { loT: 46, hiT: 50 });
  });
});

describe('findSnipes', () => {
  it('returns empty array when book is empty', () => {
    const snipes = findSnipes(book([], []), { loT: 95, hiT: 105 }, 1, 1000);
    assert.deepEqual(snipes, []);
  });

  it('returns empty array when no snipes exist (book inside band)', () => {
    const snipes = findSnipes(book([[100, 100]], [[100, 100]]), { loT: 95, hiT: 105 }, 1, 1000);
    assert.deepEqual(snipes, []);
  });

  it('finds cheap asks below band.loT - edge', () => {
    const b = book([], [[90, 100]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 2, 1000);
    assert.equal(snipes.length, 1);
    assert.equal(snipes[0]!.buy, 'yes');
    assert.equal(snipes[0]!.limitT, 90);
    assert.equal(snipes[0]!.quantity, 100);
    // gain = band.loT - priceT = 100 - 90 = 10 ticks; profit = 100 * 10 / 200 = 5
    assert.ok(Math.abs(snipes[0]!.expectedProfit - 5) < 1e-9);
  });

  it('finds expensive bids above band.hiT + edge', () => {
    const b = book([[120, 100]], []);
    const band = { loT: 90, hiT: 100 };
    const snipes = findSnipes(b, band, 2, 1000);
    assert.equal(snipes.length, 1);
    assert.equal(snipes[0]!.buy, 'no');
    assert.equal(snipes[0]!.limitT, 120);
    assert.equal(snipes[0]!.quantity, 100);
    // gain = priceT - band.hiT = 120 - 100 = 20 ticks; profit = 100 * 20 / 200 = 10
    assert.ok(Math.abs(snipes[0]!.expectedProfit - 10) < 1e-9);
  });

  it('includes level exactly at threshold', () => {
    const b = book([], [[93, 50]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 3, 1000);
    assert.equal(snipes.length, 1);
    assert.equal(snipes[0]!.quantity, 50);
    // gain = 100 - 93 = 7; profit = 50 * 7 / 200 = 1.75
    assert.ok(Math.abs(snipes[0]!.expectedProfit - 1.75) < 1e-9);
  });

  it('excludes level one tick inside threshold', () => {
    const b = book([], [[98, 50]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 3, 1000);
    assert.deepEqual(snipes, []);
  });

  it('walks multiple ask levels and stops at maxShares', () => {
    const b = book([], [[90, 100], [91, 100], [92, 100]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 1, 250);
    assert.equal(snipes.length, 1);
    assert.equal(snipes[0]!.buy, 'yes');
    assert.equal(snipes[0]!.quantity, 250);
    assert.equal(snipes[0]!.limitT, 92);
    // First 100 @ 90 gains 10 ea: 1000 ticks; next 100 @ 91 gains 9 ea: 900 ticks; partial 50 @ 92 gains 8 ea: 400 ticks
    // Total: 2300 ticks = 2300 / 200 = 11.5
    assert.ok(Math.abs(snipes[0]!.expectedProfit - 11.5) < 1e-9);
  });

  it('truncates mid-level at maxShares', () => {
    const b = book([], [[95, 1000]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 0, 75);
    assert.equal(snipes.length, 1);
    assert.equal(snipes[0]!.quantity, 75);
    assert.equal(snipes[0]!.limitT, 95);
  });

  it('finds snipes on both bid and ask sides simultaneously', () => {
    const b = book([[115, 100]], [[85, 100]]);
    const band = { loT: 100, hiT: 110 };
    const snipes = findSnipes(b, band, 3, 1000);
    assert.equal(snipes.length, 2);
    const buys = snipes.filter((s) => s.buy === 'yes');
    const sells = snipes.filter((s) => s.buy === 'no');
    assert.equal(buys.length, 1);
    assert.equal(sells.length, 1);
    assert.equal(buys[0]!.limitT, 85);
    assert.equal(sells[0]!.limitT, 115);
  });

  it('computes expectedProfit correctly with fractional ticks', () => {
    const b = book([], [[97, 60]]);
    const band = { loT: 100, hiT: 105 };
    const snipes = findSnipes(b, band, 0, 100);
    // gain = 100 - 97 = 3 ticks; profit = 60 * 3 / 200 = 0.9
    assert.ok(Math.abs(snipes[0]!.expectedProfit - 0.9) < 1e-9);
  });
});
