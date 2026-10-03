import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { createClient } from '@supabase/supabase-js';
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
  refreshToken(): Promise<void>;
  refreshTimer: NodeJS.Timeout | null;
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

describe('Feed sockets', () => {
  type FakeChannel = { topic: string; cb?: (status: string, err?: Error) => void };
  type FakeClient = {
    opts: { accessToken: () => Promise<string>; realtime: { timeout: number } };
    auths: string[];
    channels: FakeChannel[];
    removed: boolean;
  };

  // Records, per client created, what Feed asked of it; `events` is the global order of setAuth and subscribe.
  const fake = () => {
    const clients: FakeClient[] = [];
    const events: string[] = [];
    const make = ((_url: string, _key: string, opts: FakeClient['opts']) => {
      const idx = clients.length;
      const c: FakeClient = { opts, auths: [], channels: [], removed: false };
      clients.push(c);
      return {
        realtime: {
          setAuth: async (t: string) => {
            c.auths.push(t);
            events.push(`auth:${idx}`);
          },
        },
        channel(topic: string) {
          const ch: FakeChannel & Record<string, unknown> = { topic: `realtime:${topic}` };
          ch.on = () => ch;
          ch.subscribe = (cb: FakeChannel['cb']) => {
            ch.cb = cb;
            events.push(`subscribe:${idx}`);
            return ch;
          };
          c.channels.push(ch);
          return ch;
        },
        removeAllChannels: async () => {
          c.removed = true;
        },
      };
    }) as unknown as typeof createClient;
    return { clients, events, make };
  };

  const api = (token = () => 'tok') =>
    ({
      realtimeToken: async () => ({ token: token(), supabaseUrl: 'http://x', anonKey: 'anon', channels: { user: 'user:p1' } }),
    }) as unknown as Api;
  const ids = (count: number, from = 0) => Array.from({ length: count }, (_, i) => String(from + i));
  const cap = config.timing.realtimeChannelsPerSocket;
  // refreshToken runs from the timer in production; clear it first so the call does not orphan start's timer.
  const refresh = async (feed: InstanceType<typeof Feed>) => {
    const f = feed as unknown as Internals;
    clearTimeout(f.refreshTimer!);
    await f.refreshToken();
  };
  const started = async (marketCount: number, token?: () => string) => {
    const f = fake();
    const feed = new Feed(api(token), 't1', handlers(), f.make);
    await feed.start(ids(marketCount));
    return { ...f, feed };
  };

  it('puts the user channel alone on its own client and caps market channels per client', async () => {
    const markets = cap * 2 + 4;
    const { clients, feed } = await started(markets);
    try {
      assert.equal(clients.length, 1 + Math.ceil(markets / cap));
      assert.deepEqual(clients[0]!.channels.map((c) => c.topic), ['realtime:user:p1']);
      assert.deepEqual(clients.slice(1).map((c) => c.channels.length), [cap, cap, 4]);
      for (const c of clients.slice(1)) assert.ok(c.channels.every((ch) => ch.topic.includes(':market:')));
    } finally {
      await feed.stop();
    }
  });

  it('addMarkets fills the last client before opening a new one, and skips known markets', async () => {
    const { clients, feed } = await started(cap + 1);
    try {
      assert.equal(clients.length, 3);
      await feed.addMarkets(ids(cap + 1)); // all known
      assert.equal(clients.length, 3);
      await feed.addMarkets(ids(cap - 1, 100)); // fills the last client to the cap
      assert.equal(clients.length, 3);
      assert.deepEqual(clients.slice(1).map((c) => c.channels.length), [cap, cap]);
      await feed.addMarkets(['200']);
      assert.equal(clients.length, 4);
      assert.equal(clients[3]!.channels.length, 1);
    } finally {
      await feed.stop();
    }
  });

  it('addMarkets throws before start', async () => {
    const feed = new Feed(api(), 't1', handlers(), fake().make);
    await assert.rejects(() => feed.addMarkets(['1']), /before start/);
  });

  it('creates every client with the join timeout and a token callback that follows refreshes', async () => {
    let tok = 'tok1';
    const { clients, feed } = await started(cap + 1, () => tok);
    try {
      for (const c of clients) {
        assert.equal(c.opts.realtime.timeout, config.timing.realtimeJoinTimeoutMs);
        assert.equal(await c.opts.accessToken(), 'tok1');
      }
      tok = 'tok2';
      await refresh(feed);
      for (const c of clients) assert.equal(await c.opts.accessToken(), 'tok2');
    } finally {
      await feed.stop();
    }
  });

  it('authenticates each client before any of its channels subscribe', async () => {
    const { clients, events, feed } = await started(cap * 2);
    try {
      for (let i = 0; i < clients.length; i++) {
        assert.ok(events.indexOf(`auth:${i}`) >= 0 && events.indexOf(`auth:${i}`) < events.indexOf(`subscribe:${i}`), `client ${i}`);
      }
    } finally {
      await feed.stop();
    }
  });

  it('refreshes the token on every client', async () => {
    const { clients, feed } = await started(cap + 1, () => 'tok');
    try {
      await refresh(feed);
      for (const c of clients) assert.deepEqual(c.auths, ['tok', 'tok']);
    } finally {
      await feed.stop();
    }
  });

  it('stop removes the channels of every client', async () => {
    const { clients, feed } = await started(cap + 1);
    await feed.stop();
    assert.ok(clients.every((c) => c.removed));
  });

  it('a timed-out channel takes only its own market down', async () => {
    const { clients, feed } = await started(cap * 2);
    try {
      const market = (c: FakeClient, i: number) => /:market:(\d+)$/.exec(c.channels[i]!.topic)![1]!;
      for (const c of clients) for (const ch of c.channels) ch.cb!('SUBSCRIBED');
      for (let i = 0; i < ids(cap * 2).length; i++) assert.equal(feed.isLive(String(i)), true);
      const down = market(clients[1]!, 0);
      clients[1]!.channels[0]!.cb!('TIMED_OUT');
      assert.equal(feed.isLive(down), false);
      for (const c of clients.slice(1)) {
        for (let i = 0; i < c.channels.length; i++) {
          const id = market(c, i);
          if (id !== down) assert.equal(feed.isLive(id), true, id);
        }
      }
      assert.equal(feed.userLive(), true);
    } finally {
      await feed.stop();
    }
  });
});
