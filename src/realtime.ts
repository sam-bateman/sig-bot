// Supabase Realtime feeds: versioned books for each tournament market, plus our account batches.
// Delivery is best-effort; every gap, resync flag, reconnect or token refresh asks for a REST resync.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Api, AsOf, Level } from './api.js';
import { config } from './config.js';
import { log } from './log.js';

export interface PushedBook {
  exchangeId: number | string;
  asOf: AsOf | null;
  nextExpiryAt: string | null;
  bids: Level[];
  asks: Level[];
}

interface Delivery {
  revision: number;
  previousRevision: number;
}

interface MarketBatch {
  resyncRequired?: boolean;
  delivery: Delivery;
  books?: PushedBook[];
  trades?: { sequence: number | null }[];
  marketSettled?: { marketId: string }[];
}

export interface Fill {
  orderId: string | number | null;
  exchangeId: string;
  marketId: string;
  price: number | null;
  quantity: number;
}

export interface AccountBatch {
  resyncRequired?: boolean;
  delivery: Delivery;
  fills?: Fill[];
  orderUpdates?: { orderId: string | number; open: boolean }[];
  settlements?: unknown[];
}

export interface FeedHandlers {
  onBook(book: PushedBook): void;
  onMarketResync(marketId: string): void;
  onMarketSettled(marketId: string): void;
  onAccount(batch: AccountBatch): void;
  onAccountResync(): void;
}

// A failed refresh retries on this ladder (last step repeats) so we do not wait a full cycle
// past the 3h token expiry.
const REFRESH_RETRY_MS = [30_000, 60_000, 120_000, 300_000];

export class Feed {
  // One client (one socket) for the user channel, then one per config.timing.realtimeChannelsPerSocket market channels.
  private clients: SupabaseClient[] = [];
  private marketClients: { client: SupabaseClient; markets: number }[] = [];
  private supabaseUrl = '';
  private anonKey = '';
  private token = '';
  private channels: RealtimeChannel[] = [];
  private lastRevision = new Map<string, number>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshFailures = 0;
  private stopped = false;
  private liveMarkets = new Set<string>();
  private userChannelLive = false;

  constructor(
    private readonly api: Api,
    private readonly tournamentId: string,
    private readonly handlers: FeedHandlers,
    private readonly makeClient: typeof createClient = createClient,
  ) {}

  async start(marketIds: string[]) {
    const tok = await this.api.realtimeToken();
    this.token = tok.token;
    this.supabaseUrl = tok.supabaseUrl;
    this.anonKey = tok.anonKey;

    const userTopic = tok.channels.user;
    const user = (await this.newClient())
      .channel(userTopic, { config: { private: true } })
      .on('broadcast', { event: 'account_batch' }, ({ payload }) => this.onAccountBatch(userTopic, payload as AccountBatch))
      .on('broadcast', { event: 'position_settled' }, () => this.handlers.onAccountResync())
      .on('broadcast', { event: 'refund' }, () => this.handlers.onAccountResync())
      .subscribe((status, err) =>
        this.onStatus(userTopic, status, err, () => this.handlers.onAccountResync(), (up) => (this.userChannelLive = up)),
      );
    this.channels.push(user);

    await this.addMarkets(marketIds);

    this.scheduleRefresh(config.timing.tokenRefreshMs);
  }

  private async newClient(): Promise<SupabaseClient> {
    const socket = this.clients.length;
    // supabase-js re-reads the token from this callback on every heartbeat. Without it the callback
    // falls back to the anon key, and channels joined after the first heartbeat are refused.
    const client = this.makeClient(this.supabaseUrl, this.anonKey, {
      accessToken: async () => this.token,
      realtime: {
        timeout: config.timing.realtimeJoinTimeoutMs,
        heartbeatCallback: (status, latencyMs) => {
          if (status === 'timeout') log.warn('realtime heartbeat timeout', { socket });
          else if (status === 'ok' && latencyMs !== undefined && latencyMs > 5000) log.debug('realtime heartbeat slow', { socket, latencyMs });
        },
      },
    });
    await client.realtime.setAuth(this.token);
    this.clients.push(client);
    return client;
  }

  // Subscribe to more tournament markets (e.g. ones listed after startup), spreading them over sockets.
  async addMarkets(marketIds: string[]) {
    if (this.clients.length === 0) throw new Error('Feed.addMarkets called before start');
    const subscribed = new Set(this.channels.map((c) => c.topic.replace(/^realtime:/, '')));
    for (const marketId of marketIds) {
      const topic = `tournament:${this.tournamentId}:market:${marketId}`;
      if (subscribed.has(topic)) continue;
      let slot = this.marketClients.find((s) => s.markets < config.timing.realtimeChannelsPerSocket);
      if (!slot) {
        slot = { client: await this.newClient(), markets: 0 };
        this.marketClients.push(slot);
      }
      slot.markets++;
      const ch = slot.client
        .channel(topic, { config: { private: true } })
        .on('broadcast', { event: 'market_batch' }, ({ payload }) => this.onMarketBatch(topic, marketId, payload as MarketBatch))
        .on('broadcast', { event: 'book_dirty' }, () => this.handlers.onMarketResync(marketId))
        .on('broadcast', { event: 'market_settled' }, () => this.handlers.onMarketSettled(marketId))
        .subscribe((status, err) =>
          this.onStatus(topic, status, err, () => this.handlers.onMarketResync(marketId), (up) => {
            if (up) this.liveMarkets.add(marketId);
            else this.liveMarkets.delete(marketId);
          }),
        );
      this.channels.push(ch);
    }
  }

  // True while the market's tournament channel is subscribed. A token refresh re-authorizes in place
  // and leaves this untouched.
  isLive(marketId: string): boolean {
    return this.liveMarkets.has(marketId);
  }

  userLive(): boolean {
    return this.userChannelLive;
  }

  private onStatus(topic: string, status: string, err: Error | undefined, resync: () => void, setLive: (up: boolean) => void) {
    if (status === 'SUBSCRIBED') {
      log.debug('subscribed', { topic });
      setLive(true);
      this.lastRevision.delete(topic);
      resync(); // initial state, and recovery after any reconnect
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (!this.stopped) {
        log.warn('realtime channel down', {
          topic,
          status,
          err: err ? String(err) : undefined,
          cause: err?.cause ? String(err.cause) : undefined,
        });
      }
      setLive(false);
      this.lastRevision.delete(topic);
    }
  }

  // Returns true when the batch is new and contiguous; false for duplicates; resyncs on gaps.
  private accept(topic: string, d: Delivery, resyncRequired: boolean | undefined, resync: () => void): boolean {
    const last = this.lastRevision.get(topic);
    if (resyncRequired) {
      if (last === undefined || d.revision > last) this.lastRevision.set(topic, d.revision);
      resync();
      return false;
    }
    if (last !== undefined && d.revision <= last) return false;
    this.lastRevision.set(topic, d.revision);
    if (last !== undefined && d.previousRevision > last) {
      log.debug('revision gap', { topic, last, previous: d.previousRevision });
      resync();
      return false;
    }
    return true;
  }

  private onMarketBatch(topic: string, marketId: string, p: MarketBatch) {
    // Books apply by version even on a duplicate or resync batch.
    for (const b of p.books ?? []) this.handlers.onBook(b);
    const resync = () => this.handlers.onMarketResync(marketId);
    // A settlement in a gap or duplicate batch would otherwise be lost, so it does not depend on accept().
    if (p.marketSettled?.length) this.handlers.onMarketSettled(marketId);
    if (!this.accept(topic, p.delivery, p.resyncRequired, resync)) return;
    if (p.trades?.some((t) => t.sequence === null)) resync();
  }

  private onAccountBatch(topic: string, p: AccountBatch) {
    const resync = () => this.handlers.onAccountResync();
    if (!this.accept(topic, p.delivery, p.resyncRequired, resync)) return;
    this.handlers.onAccount(p);
  }

  // One pending timer at a time: the normal cadence and failure retries never overlap.
  private scheduleRefresh(ms: number) {
    if (this.stopped) return;
    this.refreshTimer = setTimeout(() => void this.refreshToken(), ms);
  }

  private async refreshToken() {
    this.refreshTimer = null;
    try {
      const tok = await this.api.realtimeToken();
      this.token = tok.token;
      await Promise.all(this.clients.map((c) => c.realtime.setAuth(tok.token)));
      log.info('realtime token refreshed');
      this.refreshFailures = 0;
      this.lastRevision.clear();
      this.handlers.onAccountResync();
      for (const ch of this.channels) {
        const m = /:market:(\d+)$/.exec(ch.topic);
        if (m) this.handlers.onMarketResync(m[1]!);
      }
    } catch (err) {
      const retryMs = REFRESH_RETRY_MS[Math.min(this.refreshFailures, REFRESH_RETRY_MS.length - 1)]!;
      this.refreshFailures++;
      log.error('realtime token refresh failed', { err: String(err), retryMs });
      this.scheduleRefresh(retryMs);
      return;
    }
    this.scheduleRefresh(config.timing.tokenRefreshMs);
  }

  async stop() {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await Promise.all(this.clients.map((c) => c.removeAllChannels()));
    this.liveMarkets.clear();
    this.userChannelLive = false;
  }
}
