import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxOrderSize, orderCost, type RiskLimits } from '../src/risk.js';

const limits: RiskLimits = { maxLegShares: 1000, maxRaceDelta: 600 };

describe('maxOrderSize, two legs', () => {
  it('flat book: delta limit binds for a bid', () => {
    // deltaPerShare = 0.5, so 600 / 0.5 = 1200 by delta; leg cap 1000 binds first
    assert.equal(maxOrderSize('bid', [0, 0], [0, 0], 0, limits), 1000);
    assert.equal(maxOrderSize('bid', [0, 0], [0, 0], 0, { maxLegShares: 5000, maxRaceDelta: 600 }), 1200);
  });

  it('is symmetric for asks on a flat book', () => {
    assert.equal(maxOrderSize('ask', [0, 0], [0, 0], 1, limits), 1000);
    assert.equal(maxOrderSize('ask', [0, 0], [0, 0], 1, { maxLegShares: 5000, maxRaceDelta: 600 }), 1200);
  });

  it('shrinks a bid by existing long position', () => {
    assert.equal(maxOrderSize('bid', [400, 0], [0, 0], 0, limits), 600);
  });

  it('lets a long position sell more', () => {
    // net +400 on leg 0: ask room by leg = 1400, by delta (600 + 200) / 0.5 = 1600
    assert.equal(maxOrderSize('ask', [400, 0], [0, 0], 0, { maxLegShares: 5000, maxRaceDelta: 600 }), 1600);
    assert.equal(maxOrderSize('ask', [400, 0], [0, 0], 0, limits), 1400);
  });

  it('subtracts resting size on the same side', () => {
    assert.equal(maxOrderSize('bid', [0, 0], [300, 0], 0, limits), 700);
    assert.equal(maxOrderSize('ask', [0, 0], [0, 250], 1, limits), 750);
  });

  it('ignores resting size on other legs', () => {
    assert.equal(maxOrderSize('bid', [0, 0], [0, 900], 0, limits), 1000);
  });

  it('is zero exactly at the leg limit', () => {
    assert.equal(maxOrderSize('bid', [1000, 1000], [0, 0], 0, limits), 0);
    assert.equal(maxOrderSize('ask', [-1000, -1000], [0, 0], 0, limits), 0);
  });

  it('is zero exactly at the race delta limit', () => {
    // delta of leg 0 = 600 when net is [600, 0]... mean 300, delta 300; use [1200,0] with big leg cap
    const l: RiskLimits = { maxLegShares: 10_000, maxRaceDelta: 600 };
    assert.equal(maxOrderSize('bid', [1200, 0], [0, 0], 0, l), 0); // delta = 600
    assert.equal(maxOrderSize('ask', [0, 1200], [0, 0], 0, l), 0); // delta = -600
  });

  it('delta limit binds before leg limit when legs are unbalanced', () => {
    // net [500, -500] -> mean 0, delta +500; room (600 - 500)/0.5 = 200 ; leg room 500
    assert.equal(maxOrderSize('bid', [500, -500], [0, 0], 0, limits), 200);
  });

  it('allows trading toward balance when delta is over the limit on the other side', () => {
    // leg 1 is at delta -500; selling it is limited, buying it is generous
    assert.equal(maxOrderSize('ask', [500, -500], [0, 0], 1, limits), 200);
    assert.equal(maxOrderSize('bid', [500, -500], [0, 0], 1, limits), 1500); // leg room 1000 + 500
  });

  it('never goes negative', () => {
    assert.equal(maxOrderSize('bid', [2000, 0], [0, 0], 0, limits), 0);
    assert.equal(maxOrderSize('ask', [-2000, 0], [0, 0], 0, limits), 0);
    assert.equal(maxOrderSize('bid', [0, 0], [5000, 0], 0, limits), 0);
    assert.equal(maxOrderSize('ask', [0, 0], [5000, 5000], 1, limits), 0);
  });

  it('returns whole shares', () => {
    const q = maxOrderSize('bid', [0, 0], [0.5, 0], 0, { maxLegShares: 100, maxRaceDelta: 1000 });
    assert.equal(q, 99);
    assert.ok(Number.isInteger(q));
  });
});

describe('maxOrderSize, three legs', () => {
  const l3: RiskLimits = { maxLegShares: 10_000, maxRaceDelta: 600 };

  // 1 - 1/3 is not exactly 2/3 in floating point, so exact-integer budgets can floor one share low.
  // These tests accept that single-share slack; the strict version is in the next test.
  const approx = (actual: number, expected: number) =>
    assert.ok(actual === expected || actual === expected - 1, `expected ${expected} (or ${expected - 1}), got ${actual}`);

  it('uses deltaPerShare = 2/3', () => {
    approx(maxOrderSize('bid', [0, 0, 0], [0, 0, 0], 0, l3), 900);
    approx(maxOrderSize('ask', [0, 0, 0], [0, 0, 0], 2, l3), 900);
  });

  it('exact budgets are not lost to float error (600 / (2/3) = 900)', () => {
    // BUG in src/risk.ts: deltaPerShare = 1 - 1/3 = 0.6666666666666667, so 600 / it = 899.9999999999999
    // and Math.floor gives 899.
    assert.equal(maxOrderSize('bid', [0, 0, 0], [0, 0, 0], 0, l3), 900);
  });

  it('measures delta against the mean of all three legs', () => {
    // net [300, 0, 0] -> mean 100, delta(0) = 200; bid room (600-200)/(2/3) = 600
    approx(maxOrderSize('bid', [300, 0, 0], [0, 0, 0], 0, l3), 600);
    // leg 1 delta = -100; bid room (600+100)/(2/3) = 1050
    approx(maxOrderSize('bid', [300, 0, 0], [0, 0, 0], 1, l3), 1050);
    // leg 1 ask room (600-100)/(2/3) = 750
    approx(maxOrderSize('ask', [300, 0, 0], [0, 0, 0], 1, l3), 750);
  });

  it('subtracts resting size from the delta room in shares', () => {
    approx(maxOrderSize('bid', [0, 0, 0], [200, 0, 0], 0, l3), 700);
  });

  it('is zero at limits and never negative', () => {
    assert.equal(maxOrderSize('bid', [10_000, 0, 0], [0, 0, 0], 0, { maxLegShares: 10_000, maxRaceDelta: 1e9 }), 0);
    assert.equal(maxOrderSize('bid', [900, 0, 0], [0, 0, 0], 0, { maxLegShares: 10_000, maxRaceDelta: 600 }), 0);
    assert.equal(maxOrderSize('bid', [5000, 0, 0], [0, 0, 0], 0, l3), 0);
  });

  it('a leg limit binds when it is tighter than the delta limit', () => {
    assert.equal(maxOrderSize('bid', [0, 0, 0], [0, 0, 0], 0, { maxLegShares: 500, maxRaceDelta: 600 }), 500);
  });

  it('treats a missing resting entry as zero', () => {
    approx(maxOrderSize('bid', [0, 0, 0], [], 0, l3), 900);
  });
});

describe('orderCost', () => {
  it('bid costs price * quantity', () => {
    assert.equal(orderCost('bid', 100, 10), 5);
    assert.equal(orderCost('bid', 60, 100), 30);
  });

  it('ask costs (1 - price) * quantity', () => {
    assert.equal(orderCost('ask', 100, 10), 5);
    assert.equal(orderCost('ask', 60, 100), 70);
  });

  it('bid and ask at the same price cost one unit per share together', () => {
    for (const t of [1, 37, 100, 199]) {
      assert.ok(Math.abs(orderCost('bid', t, 40) + orderCost('ask', t, 40) - 40) < 1e-9);
    }
  });

  it('is zero for zero quantity and honors a custom ticksPerUnit', () => {
    assert.equal(orderCost('bid', 100, 0), 0);
    assert.equal(orderCost('bid', 50, 10, 100), 5);
    assert.equal(orderCost('ask', 25, 100, 100), 75);
  });
});
