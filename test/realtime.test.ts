import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Api } from '../src/api.js';
import type { FeedHandlers } from '../src/realtime.js';

// config reads required env at import; a dummy key keeps the real .env out of the test.
process.env.SIG_API_KEY = 'test-key';
const { Feed } = await import('../src/realtime.js');
const { config } = await import('../src/config.js');

const handlers = (settled: string[] = []): FeedHandlers => ({
  onBook() {},
  onMarketResync() {},
  onMarketSettled: (id) => void settled.push(id),
  onAccount() {},
  onAccountResync() {},
});

// The private surface is the unit under test; there is no socket to fake around it.
type Internals = {
  onStatus(topic: string, status: string, err: Error | undefined, resync: () => void, setLive: (up: boolean) => void): void;
  onMarketBatch(topic: string, marketId: string, p: unknown): void;
  scheduleRefresh(ms: number): void;
};

describe('Feed token refresh', () => {
  it('retries a failed refresh with backoff, then resumes the normal cadence', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let calls = 0;
      let failing = true;
      const api = {
        realtimeToken: async () => {
          calls++;
          if (failing) throw new Error('boom');
          return { token: 't' };
        },
      } as unknown as Api;
      const feed = new Feed(api, 't1', handlers());
      (feed as unknown as Internals).scheduleRefresh(config.timing.tokenRefreshMs);

      const tick = async (ms: number) => {
        mock.timers.tick(ms);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };

      await tick(config.timing.tokenRefreshMs);
      assert.equal(calls, 1);
      await tick(29_999);
      assert.equal(calls, 1);
      await tick(1); // +30s
      assert.equal(calls, 2);
      await tick(60_000);
      assert.equal(calls, 3);
      await tick(120_000);
      assert.equal(calls, 4);
      await tick(300_000);
      assert.equal(calls, 5);
      await tick(300_000); // capped at 5 min
      assert.equal(calls, 6);

      failing = false;
      await tick(300_000);
      assert.equal(calls, 7);
      await tick(config.timing.tokenRefreshMs - 1);
      assert.equal(calls, 7);
      await tick(1);
      assert.equal(calls, 8);

      await feed.stop();
      await tick(config.timing.tokenRefreshMs * 2);
      assert.equal(calls, 8);
    } finally {
      mock.timers.reset();
    }
  });

  it('stop cancels a pending retry', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let calls = 0;
      const api = {
        realtimeToken: async () => {
          calls++;
          throw new Error('boom');
        },
      } as unknown as Api;
      const feed = new Feed(api, 't1', handlers());
      (feed as unknown as Internals).scheduleRefresh(1000);
      mock.timers.tick(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(calls, 1);
      await feed.stop(); // a 30s retry is pending
      mock.timers.tick(10 * 60_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(calls, 1);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('Feed channel health', () => {
  it('tracks per-market and user liveness from channel status', () => {
    const feed = new Feed({} as Api, 't1', handlers());
    const f = feed as unknown as Internals;
    let live = false;
    const set = (up: boolean) => (live = up);
    assert.equal(feed.isLive('7'), false);
    assert.equal(feed.userLive(), false);
    f.onStatus('topic', 'SUBSCRIBED', undefined, () => {}, set);
    assert.equal(live, true);
    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
      f.onStatus('topic', 'SUBSCRIBED', undefined, () => {}, set);
      f.onStatus('topic', status, undefined, () => {}, set);
      assert.equal(live, false, status);
    }
  });
});

describe('Feed marketSettled', () => {
  const batch = (revision: number, previousRevision: number, extra: object = {}) => ({
    delivery: { revision, previousRevision },
    marketSettled: [{ marketId: '7' }],
    ...extra,
  });

  it('fires for a gap batch', () => {
    const settled: string[] = [];
    const f = new Feed({} as Api, 't1', handlers(settled)) as unknown as Internals;
    f.onMarketBatch('t', '7', { delivery: { revision: 1, previousRevision: 0 } });
    f.onMarketBatch('t', '7', batch(9, 5)); // gap: accept() returns false
    assert.deepEqual(settled, ['7']);
  });

  it('fires for a contiguous batch and not for one without settlements', () => {
    const settled: string[] = [];
    const f = new Feed({} as Api, 't1', handlers(settled)) as unknown as Internals;
    f.onMarketBatch('t', '7', { delivery: { revision: 1, previousRevision: 0 } });
    assert.deepEqual(settled, []);
    f.onMarketBatch('t', '7', batch(2, 1));
    assert.deepEqual(settled, ['7']);
  });
});
