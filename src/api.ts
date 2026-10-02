import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { TokenBucket } from './ratelimit.js';

export interface Level {
  price: number;
  quantity: number;
}

export interface AsOf {
  sequence: number;
  at: string;
}

export interface ExchangeBook {
  exchangeId: string;
  marketId: string;
  asOf: AsOf | null;
  bids: Level[];
  asks: Level[];
}

export interface Quote {
  exchangeId: string;
  marketId: string;
  latestPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface Market {
  id: string;
  title: string;
  status: string;
  exchanges: { id: string; option: string; latestPrice: number | null }[];
}

export interface Tournament {
  id: string;
  slug: string;
  name: string;
  status: string;
  endDate: string;
  myBalance: number;
}

export interface Position {
  exchangeId: string;
  marketId: string;
  marketTitle: string;
  settled: boolean;
  quantity: number;
  avgCost: number;
  currentPrice: number | null;
  costBasis: number;
  unrealizedPnl: number;
  lots: { side: string; quantity: number; entryPrice: number }[];
}

export interface RestOrder {
  id: number;
  exchangeId: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  quantity: number;
  priceLimit: number | null;
  open: boolean;
  expirationDate: string | null;
}

export interface OrderRequest {
  exchangeId: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  quantity: number;
  price: number;
  expirationDate?: string;
  tournamentId: string;
}

// Single, batch-item and multi-leg success payloads share these fields.
export interface OrderResult {
  orderId?: number | string;
  id?: number | string;
  open?: boolean;
  quantityTraded?: number;
  fillPrice?: number | null;
  terminalReasonCode?: string | null;
}

export interface BatchItem {
  index: number;
  ok: boolean;
  status: number;
  data: OrderResult & { error?: unknown; code?: string };
}

export interface RealtimeToken {
  token: string;
  expiresAt: string;
  supabaseUrl: string;
  anonKey: string;
  channels: { user: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

// The call ran out of time; it may still have executed in part, so reconcile before trusting local state.
export class DeadlineError extends Error {
  constructor(readonly path: string) {
    super(`${path}: deadline passed, not retrying`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Api {
  readonly reads = new TokenBucket(config.limits.readsPerMin);
  readonly writes = new TokenBucket(config.limits.writesPerMin);

  // `deadline` (epoch ms) bounds the whole call, retries included: past it, the request is abandoned
  // with DeadlineError rather than resent. Use it for payloads that go stale, like expiring quotes.
  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; deadline?: number } = {},
  ): Promise<T> {
    const isRead = method === 'GET';
    const bucket = isRead ? this.reads : this.writes;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${config.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;

    const deadline = opts.deadline ?? Infinity;
    const wait = async (ms: number) => {
      if (Date.now() + ms >= deadline) throw new DeadlineError(path);
      await sleep(ms);
    };

    // Every retry below reuses the same body, so idempotency keys carry over.
    for (let attempt = 0; ; attempt++) {
      await bucket.take();
      const left = deadline - Date.now();
      if (left <= 0) throw new DeadlineError(path);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(Math.min(30_000, left)),
        });
      } catch (err) {
        if (attempt >= 4) throw err;
        log.warn('network error, retrying', { path, attempt, err: String(err) });
        await wait(backoff(attempt));
        continue;
      }

      const text = await res.text();
      const json = text ? safeJson(text) : null;
      // A batch with at least one success comes back as 207; the caller reads per-item results.
      if (res.ok) return json as T;

      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const code = err?.code ?? `HTTP_${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;

      if (res.status === 429) {
        bucket.pause(retryAfter || 60_000);
        if (Date.now() + (retryAfter || 60_000) >= deadline) throw new DeadlineError(path);
        if (attempt < 3) {
          log.warn('rate limited', { path, code, retryAfterMs: retryAfter || 60_000 });
          continue;
        }
      } else if (
        (res.status === 503 || res.status === 502 || code === 'REQUEST_IN_FLIGHT') &&
        attempt < 4
      ) {
        const ms = code === 'REQUEST_IN_FLIGHT' ? 90_000 : Math.max(retryAfter, backoff(attempt));
        log.warn('transient error, retrying', { path, code, attempt, waitMs: ms });
        await wait(ms);
        continue;
      }
      throw new ApiError(res.status, code, err?.message ?? text.slice(0, 300), err?.details ?? json);
    }
  }

  get<T>(path: string, query?: Record<string, unknown>) {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  // ---- reads ----

  tournament(slug: string) {
    return this.get<Tournament>(`/tournaments/${slug}`);
  }

  async tournamentMarkets(slug: string): Promise<Market[]> {
    const out: Market[] = [];
    let cursor: string | undefined;
    for (;;) {
      // This endpoint ignores `offset`; only the cursor advances.
      const r = await this.get<{ data: Market[]; pagination: { hasMore: boolean; nextCursor?: string | null } }>(
        `/tournaments/${slug}/markets`,
        { limit: 100, cursor },
      );
      out.push(...r.data);
      if (!r.pagination.hasMore || !r.pagination.nextCursor || r.pagination.nextCursor === cursor) return out;
      cursor = r.pagination.nextCursor;
    }
  }

  async quotes(exchangeIds: string[], tournamentId: string): Promise<Quote[]> {
    const out: Quote[] = [];
    for (let i = 0; i < exchangeIds.length; i += 100) {
      const r = await this.get<{ data: Quote[] }>('/exchanges/prices', {
        ids: exchangeIds.slice(i, i + 100).join(','),
        tournamentId,
      });
      out.push(...r.data);
    }
    return out;
  }

  orderbook(exchangeId: string, tournamentId: string) {
    return this.get<ExchangeBook>(`/exchanges/${exchangeId}/orderbook`, { tournamentId, depth: 200 });
  }

  positions(slug: string) {
    return this.get<{ positions: Position[]; summary: { totalCostBasis: number; totalMarketValue: number; totalUnrealizedPnl: number } }>(
      `/tournaments/${slug}/portfolio/positions`,
    );
  }

  pnl(slug: string) {
    return this.get<Record<string, unknown>>(`/tournaments/${slug}/portfolio/pnl`);
  }

  leaderboard(slug: string) {
    return this.get<Record<string, unknown>>(`/tournaments/${slug}/leaderboard`, { period: 'all', limit: 10 });
  }

  async openOrders(tournamentId: string): Promise<RestOrder[]> {
    const out: RestOrder[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await this.get<{ data: RestOrder[]; pagination: { hasMore: boolean; nextCursor: string | null } }>('/orders', {
        status: 'open',
        tournamentId,
        limit: 200,
        cursor,
      });
      out.push(...r.data);
      if (!r.pagination.hasMore || !r.pagination.nextCursor) return out;
      cursor = r.pagination.nextCursor;
    }
  }

  // ---- writes ----

  placeBatch(orders: OrderRequest[], deadline?: number) {
    return this.request<{ results: BatchItem[] }>('POST', '/orders/batch', {
      body: { idempotencyKey: randomUUID(), orders },
      deadline,
    });
  }

  placeMultiLeg(legs: OrderRequest[], deadline?: number) {
    return this.request<{ legs?: OrderResult[]; orders?: OrderResult[]; results?: OrderResult[] }>('POST', '/orders/multi-leg', {
      body: { idempotencyKey: randomUUID(), legs },
      deadline,
    });
  }

  // Retries until the server confirms nothing targeted is still resting.
  async cancelAll(scope: { tournamentId: string; marketId?: string }): Promise<number> {
    const r = await this.post<{ cancelled?: number }>('/orders/cancel-all', scope);
    return r?.cancelled ?? 0;
  }

  realtimeToken() {
    return this.post<RealtimeToken>('/realtime/token');
  }
}

function backoff(attempt: number) {
  return Math.min(10_000, 250 * 2 ** attempt) * (0.5 + Math.random());
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}
