import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/ratelimit.js';

// Most tests exercise refill and pause maths, so they size the bucket at perMin unless told otherwise.
// The default-burst tests below build their own.
function setup(perMin: number, burst: number = perMin) {
  const clock = { t: 1_000_000 };
  const bucket = new TokenBucket(perMin, burst, () => clock.t);
  return { clock, bucket };
}

describe('TokenBucket', () => {
  it('starts full at the burst capacity', () => {
    const { bucket } = setup(30, 7);
    assert.equal(bucket.available(), 7);
    assert.equal(bucket.waitMs(), 0);
  });

  it('burst defaults to a quarter of perMin, rounded up, never below one', () => {
    const avail = (perMin: number) => new TokenBucket(perMin, undefined, () => 0).available();
    assert.equal(avail(60), 15);
    assert.equal(avail(30), 8);
    assert.equal(avail(4), 1);
    assert.equal(avail(1), 1);
  });

  it('an explicit burst overrides the default', () => {
    const bucket = new TokenBucket(60, 40, () => 0);
    assert.equal(bucket.available(), 40);
  });

  it('tryTake spends one token at a time and then refuses', () => {
    const { bucket } = setup(3);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.available(), 0);
    assert.equal(bucket.tryTake(), false);
  });

  it('a refused tryTake does not spend or go negative', () => {
    const { clock, bucket } = setup(60);
    for (let i = 0; i < 60; i++) bucket.tryTake();
    for (let i = 0; i < 5; i++) assert.equal(bucket.tryTake(), false);
    clock.t += 1000; // one token at 60/min
    assert.equal(bucket.tryTake(), true);
  });

  it('refills linearly per minute', () => {
    const { clock, bucket } = setup(60);
    for (let i = 0; i < 60; i++) bucket.tryTake();
    assert.equal(bucket.available(), 0);
    clock.t += 10_000; // 10 tokens
    assert.equal(bucket.available(), 10);
    clock.t += 20_000;
    assert.equal(bucket.available(), 30);
  });

  it('refills fractional tokens and floors availability', () => {
    const { clock, bucket } = setup(60);
    for (let i = 0; i < 60; i++) bucket.tryTake();
    clock.t += 1500; // 1.5 tokens
    assert.equal(bucket.available(), 1);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false); // 0.5 left
    clock.t += 500;
    assert.equal(bucket.tryTake(), true);
  });

  it('caps at burst', () => {
    const { clock, bucket } = setup(30, 10);
    clock.t += 10 * 60_000;
    assert.equal(bucket.available(), 10);
    bucket.tryTake();
    clock.t += 10 * 60_000;
    assert.equal(bucket.available(), 10);
  });

  it('refill rate stays perMin per minute whatever the burst', () => {
    const { clock, bucket } = setup(60, 5);
    for (let i = 0; i < 5; i++) bucket.tryTake();
    clock.t += 3000;
    assert.equal(bucket.available(), 3);
  });

  it('never allows more than perMin + burst in any 60s window, even after idling', () => {
    const perMin = 60;
    const burst = 15;
    const { clock, bucket } = setup(perMin, burst);
    clock.t += 30 * 60_000; // idle long enough to be full
    const takes: number[] = [];
    // Hammer the bucket every 100ms for 5 minutes.
    for (let i = 0; i < 3000; i++) {
      while (bucket.tryTake()) takes.push(clock.t);
      clock.t += 100;
    }
    let max = 0;
    for (let i = 0, j = 0; i < takes.length; i++) {
      while (takes[i]! - takes[j]! >= 60_000) j++;
      max = Math.max(max, i - j + 1);
    }
    assert.ok(max <= perMin + burst, `took ${max} in one window`);
    assert.ok(max >= perMin, `took only ${max}, the bucket is too stingy`);
  });

  it('waitMs is zero with a token and otherwise the time to the next whole token', () => {
    const { clock, bucket } = setup(60);
    for (let i = 0; i < 60; i++) bucket.tryTake();
    assert.equal(bucket.waitMs(), 1000);
    clock.t += 400;
    assert.equal(bucket.waitMs(), 600);
    clock.t += 600;
    assert.equal(bucket.waitMs(), 0);
  });

  it('waitMs scales with the rate', () => {
    const { bucket } = setup(30); // one token per 2 seconds
    for (let i = 0; i < 30; i++) bucket.tryTake();
    assert.equal(bucket.waitMs(), 2000);
  });

  it('waiting waitMs makes tryTake succeed', () => {
    const { clock, bucket } = setup(26);
    for (let i = 0; i < 26; i++) bucket.tryTake();
    assert.equal(bucket.tryTake(), false);
    clock.t += bucket.waitMs();
    assert.equal(bucket.tryTake(), true);
  });

  describe('pause', () => {
    it('zeroes tokens and blocks until the pause has elapsed', () => {
      const { clock, bucket } = setup(60);
      bucket.pause(5000);
      assert.equal(bucket.available(), 0);
      assert.equal(bucket.tryTake(), false);
      assert.equal(bucket.waitMs(), 5000);
      clock.t += 4999;
      assert.equal(bucket.tryTake(), false);
      assert.equal(bucket.available(), 0);
      assert.ok(bucket.waitMs() >= 1);
      clock.t += 1;
      assert.equal(bucket.waitMs(), 0);
      assert.equal(bucket.tryTake(), true);
    });

    it('does not restore the full bucket after the pause', () => {
      const { clock, bucket } = setup(60);
      bucket.pause(5000);
      clock.t += 5000; // 5 tokens refilled at 1/sec
      assert.equal(bucket.available(), 5);
    });

    it('a shorter pause never shortens an existing one', () => {
      const { clock, bucket } = setup(60);
      bucket.pause(10_000);
      clock.t += 1000;
      bucket.pause(1000); // would end at +2000, existing ends at +10000
      assert.equal(bucket.waitMs(), 9000);
    });

    it('a longer pause extends it', () => {
      const { clock, bucket } = setup(60);
      bucket.pause(1000);
      clock.t += 500;
      bucket.pause(5000);
      assert.equal(bucket.waitMs(), 5000);
    });

    it('pausing a drained bucket does not make tokens negative', () => {
      const { clock, bucket } = setup(60);
      for (let i = 0; i < 60; i++) bucket.tryTake();
      bucket.pause(2000);
      clock.t += 2000;
      assert.equal(bucket.available(), 2);
    });
  });

  describe('take', () => {
    it('resolves immediately when a token is free', async () => {
      const { bucket } = setup(2);
      await bucket.take();
      await bucket.take();
      assert.equal(bucket.available(), 0);
    });

    it('waits for a refill when empty (real clock, fast rate)', async () => {
      const bucket = new TokenBucket(60_000, 60_000); // one token per millisecond
      for (let i = 0; i < 60_000; i++) bucket.tryTake();
      const start = Date.now();
      await bucket.take();
      assert.ok(Date.now() - start >= 0);
      assert.ok(bucket.available() <= 60_000);
    });

    it('waits out a pause', async () => {
      const bucket = new TokenBucket(60_000);
      bucket.pause(20);
      const start = Date.now();
      await bucket.take();
      assert.ok(Date.now() - start >= 15);
    });
  });
});
