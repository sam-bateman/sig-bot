import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newMarkets, MarketWatcher } from '../src/watcher.js';
import type { Market, Api } from '../src/api.js';

let n = 0;
const market = (title: string, status: string = 'open'): Market => {
  n++;
  return {
    id: `m${n}`,
    title,
    status,
    exchanges: [{ id: `e${n}`, option: 'Yes', latestPrice: null }],
  };
};

describe('newMarkets', () => {
  it('returns empty array when market list is empty', () => {
    const result = newMarkets(new Set(['m1', 'm2']), []);
    assert.deepEqual(result, []);
  });

  it('returns empty array when all markets are known', () => {
    const m1 = market('Market 1');
    const m2 = market('Market 2');
    const known = new Set([m1.id, m2.id]);
    const result = newMarkets(known, [m1, m2]);
    assert.deepEqual(result, []);
  });

  it('returns only unknown open markets', () => {
    const m1 = market('Known Market');
    const m2 = market('New Open Market');
    const m3 = market('New Closed Market', 'closed');
    const known = new Set([m1.id]);
    const result = newMarkets(known, [m1, m2, m3]);
    assert.deepEqual(result, [m2]);
  });

  it('filters out known markets regardless of status', () => {
    const m1 = market('Known Open');
    const m2 = market('Known Closed', 'closed');
    const m3 = market('New Open');
    const known = new Set([m1.id, m2.id]);
    const result = newMarkets(known, [m1, m2, m3]);
    assert.deepEqual(result, [m3]);
  });

  it('handles market list with only closed status markets', () => {
    const m1 = market('Closed 1', 'closed');
    const m2 = market('Closed 2', 'resolved');
    const result = newMarkets(new Set(), [m1, m2]);
    assert.deepEqual(result, []);
  });

  it('includes all unknown open markets', () => {
    const m1 = market('New 1');
    const m2 = market('New 2');
    const m3 = market('New 3');
    const result = newMarkets(new Set(), [m1, m2, m3]);
    assert.deepEqual(result, [m1, m2, m3]);
  });

  it('preserves market order from input list', () => {
    const m1 = market('Market A');
    const m2 = market('Market B');
    const m3 = market('Market C');
    const result = newMarkets(new Set(), [m1, m2, m3]);
    assert.equal(result[0]!.title, 'Market A');
    assert.equal(result[1]!.title, 'Market B');
    assert.equal(result[2]!.title, 'Market C');
  });

  it('does not include closed status', () => {
    const m = market('Closed Market', 'closed');
    const result = newMarkets(new Set(), [m]);
    assert.deepEqual(result, []);
  });

  it('includes resolved status as closed (filtered out)', () => {
    const m = market('Resolved Market', 'resolved');
    const result = newMarkets(new Set(), [m]);
    assert.deepEqual(result, []);
  });
});

describe('MarketWatcher.poll', () => {
  it('returns only unseen open markets on first poll', async () => {
    const m1 = market('Initial Market');
    const m2 = market('New Market 1');
    const m3 = market('New Market 2');
    const m4 = market('Closed Market', 'closed');

    const api = {
      tournamentMarkets: async () => [m1, m2, m3, m4],
    } as unknown as Api;

    const watcher = new MarketWatcher(api, 'test-slug', [m1]);
    const result = await watcher.poll();

    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((m) => m.id),
      [m2.id, m3.id],
    );
  });

  it('returns empty array on subsequent poll when no new markets', async () => {
    const m1 = market('Market 1');
    const m2 = market('Market 2');

    const api = {
      tournamentMarkets: async () => [m1, m2],
    } as unknown as Api;

    const watcher = new MarketWatcher(api, 'test-slug', [m1, m2]);
    const result = await watcher.poll();

    assert.deepEqual(result, []);
  });

  it('tracks markets across multiple polls', async () => {
    const m1 = market('Initial');
    const m2 = market('Added in Poll 1');
    const m3 = market('Added in Poll 2');

    let callCount = 0;
    const api = {
      tournamentMarkets: async () => {
        callCount++;
        if (callCount === 1) return [m1];
        if (callCount === 2) return [m1, m2];
        return [m1, m2, m3];
      },
    } as unknown as Api;

    const watcher = new MarketWatcher(api, 'test-slug', []);

    const poll1 = await watcher.poll();
    assert.equal(poll1.length, 1);
    assert.equal(poll1[0]!.id, m1.id);

    const poll2 = await watcher.poll();
    assert.equal(poll2.length, 1);
    assert.equal(poll2[0]!.id, m2.id);

    const poll3 = await watcher.poll();
    assert.equal(poll3.length, 1);
    assert.equal(poll3[0]!.id, m3.id);
  });

  it('filters out closed markets even if they are new', async () => {
    const m1 = market('Initial');
    const m2 = market('New Open');
    const m3 = market('New Closed', 'closed');

    const api = {
      tournamentMarkets: async () => [m1, m2, m3],
    } as unknown as Api;

    const watcher = new MarketWatcher(api, 'test-slug', [m1]);
    const result = await watcher.poll();

    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, m2.id);
  });

  it('initializes with known markets', async () => {
    const m1 = market('Initial 1');
    const m2 = market('Initial 2');
    const m3 = market('New Market');

    const api = {
      tournamentMarkets: async () => [m1, m2, m3],
    } as unknown as Api;

    const watcher = new MarketWatcher(api, 'test-slug', [m1, m2]);
    const result = await watcher.poll();

    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, m3.id);
  });
});
