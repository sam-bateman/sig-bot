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
  private client: SupabaseClient | null = null;
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
  ) {}

  async start(marketIds: string[]) {
    const tok = await this.api.realtimeToken();
    this.client = createClient(tok.supabaseUrl, tok.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await this.client.realtime.setAuth(tok.token);

    for (const marketId of marketIds) {
      const topic = `tournament:${this.tournamentId}:market:${marketId}`;
      const ch = this.client
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

    const userTopic = tok.channels.user;
    const user = this.client
      .channel(userTopic, { config: { private: true } })
      .on('broadcast', { event: 'account_batch' }, ({ payload }) => this.onAccountBatch(userTopic, payload as AccountBatch))
      .on('broadcast', { event: 'position_settled' }, () => this.handlers.onAccountResync())
      .on('broadcast', { event: 'refund' }, () => this.handlers.onAccountResync())
      .subscribe((status, err) =>
        this.onStatus(userTopic, status, err, () => this.handlers.onAccountResync(), (up) => (this.userChannelLive = up)),
      );
    this.channels.push(user);

    this.scheduleRefresh(config.timing.tokenRefreshMs);
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
      log.warn('realtime channel down', { topic, status, err: err?.message });
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
      await this.client?.realtime.setAuth(tok.token);
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
    await this.client?.removeAllChannels();
    this.liveMarkets.clear();
    this.userChannelLive = false;
  }
}
