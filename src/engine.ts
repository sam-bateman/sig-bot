import { Api, ApiError, type OrderRequest, type OrderResult, type Tournament } from './api.js';
import { BookStore } from './books.js';
import { config, TICKS_PER_UNIT } from './config.js';
import { log } from './log.js';
import { Feed, type AccountBatch } from './realtime.js';
import { maxOrderSize, orderCost } from './risk.js';
import { externalBook, OrderBookkeeper, Placements, Positions, remaining, type OwnOrder } from './state.js';
import {
  fairValues,
  findArb,
  findSnipes,
  impliedBand,
  fromTicks,
  quoteLeg,
  raceDeltas,
  raceScore,
  toTicks,
  touch,
  type Arb,
  type Snipe,
  type Touch,
} from './strategy.js';
import { buildRaces, parseLeg, type Leg, type Race } from './universe.js';
import { MarketWatcher } from './watcher.js';

interface Desired {
  race: string;
  exchangeId: string;
  marketId: string;
  side: 'bid' | 'ask';
  priceT: number;
  size: number;
}

interface PlannedArb {
  race: Race;
  arb: Arb;
}

interface PlannedSnipe {
  race: Race;
  leg: Leg;
  snipe: Snipe;
  band: { loT: number; hiT: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  readonly api = new Api();
  private readonly books = new BookStore();
  private readonly orders = new OrderBookkeeper();
  private readonly positions = new Positions();
  // Every order we placed, so fills can be attributed after the order leaves the book and orders
  // with an unseen outcome count against the limits.
  private readonly placements = new Placements();
  private recentFills: { at: number; exchangeId: string; side: 'bid' | 'ask'; qty: number }[] = [];
  private snapshotAt = 0;
  // Exchange+side pairs whose last placement was rejected outright; skipped until the time given.
  private readonly cooldown = new Map<string, number>();
  // Race name -> time before which no new arb is fired on it.
  private readonly arbCooldown = new Map<string, number>();
  private readonly resyncQueue = new Set<string>();
  private readonly marketToExchange = new Map<string, string>();
  private readonly exchangeToMarket = new Map<string, string>();
  private readonly settled = new Set<string>();
  private tournament!: Tournament;
  private feed!: Feed;
  private active: Race[] = [];
  // Every race seen, including ones with a single leg so far, keyed by name.
  private readonly allRaces = new Map<string, Race>();
  // Exchanges listed after startup, with when we first saw them.
  private readonly fresh = new Map<string, number>();
  private watcher!: MarketWatcher;
  private lastWatch = Date.now();
  private needReconcile = true;
  private lastReconcile = 0;
  private lastReconcileOk = Date.now();
  private frozen = false;
  private lastPlanKey = new Map<string, string>();
  private lastSummary = 0;
  private running = true;

  async init() {
    this.tournament = await this.api.tournament(config.tournamentSlug);
    log.info('tournament', {
      name: this.tournament.name,
      status: this.tournament.status,
      balance: this.tournament.myBalance,
      ends: this.tournament.endDate,
      mode: config.live ? 'LIVE' : 'dry-run',
    });

    // Markets hidden at startup are "discovered" by the first watcher poll; for dry-run testing.
    const hidden = new Set(config.watch.simulateNew);
    const markets = (await this.api.tournamentMarkets(config.tournamentSlug)).filter((m) => !hidden.has(m.id));
    for (const m of markets) this.addLeg(m);
    this.watcher = new MarketWatcher(this.api, config.tournamentSlug, markets);
    const { races, unmatched } = buildRaces(markets);
    if (unmatched.length) log.info('markets not in a race (ignored)', { titles: unmatched.map((m) => m.title) });
    // buildRaces makes fresh race objects; quote the canonical ones so later legs show up.
    this.active = (await this.selectRaces(races)).map((r) => this.allRaces.get(r.name)!);
    for (const r of this.active) this.mapLegs(r);
    log.info('quoting races', { races: this.active.map((r) => r.name) });

    if (config.live) {
      const n = await this.api.cancelAll({ tournamentId: this.tournament.id });
      log.info('cancelled leftover orders', { cancelled: n });
    }
    await this.reconcile();

    this.feed = new Feed(this.api, this.tournament.id, {
      onBook: (b) => this.books.apply(String(b.exchangeId), b, b.asOf, b.nextExpiryAt),
      onMarketResync: (marketId) => {
        const ex = this.marketToExchange.get(marketId);
        if (ex) this.resyncQueue.add(ex);
      },
      onMarketSettled: (marketId) => {
        this.settled.add(marketId);
        this.needReconcile = true;
        log.info('market settled', { marketId });
      },
      onAccount: (b) => this.onAccount(b),
      onAccountResync: () => (this.needReconcile = true),
    });
    await this.feed.start(this.active.flatMap((r) => r.legs.map((l) => l.marketId)));
  }

  // Rank races by how contested they look from the bulk price snapshot.
  private async selectRaces(races: Race[]): Promise<Race[]> {
    const ids = races.flatMap((r) => r.legs.map((l) => l.exchangeId));
    const quotes = new Map((await this.api.quotes(ids, this.tournament.id)).map((q) => [q.exchangeId, q]));
    const scored: { race: Race; score: number }[] = [];
    for (const race of races) {
      const touches: Touch[] = [];
      for (const leg of race.legs) {
        const q = quotes.get(leg.exchangeId);
        if (!q?.bestBid || !q.bestAsk) break;
        touches.push({ bidT: toTicks(q.bestBid), askT: toTicks(q.bestAsk) });
      }
      if (touches.length !== race.legs.length) continue;
      scored.push({ race, score: raceScore(fairValues(touches, config.strategy.otherMaxTicks)) });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, config.strategy.maxRaces).map((s) => s.race);
  }

  private addLeg(m: Parameters<typeof parseLeg>[0]): { race: Race; leg: Leg } | null {
    const parsed = parseLeg(m);
    if (!parsed) return null;
    const race = this.allRaces.get(parsed.name) ?? { name: parsed.name, legs: [] };
    if (race.legs.some((l) => l.party === parsed.leg.party)) return null;
    race.legs.push(parsed.leg);
    race.legs.sort((a, b) => 'RDI'.indexOf(a.party) - 'RDI'.indexOf(b.party));
    this.allRaces.set(parsed.name, race);
    return { race, leg: parsed.leg };
  }

  private mapLegs(race: Race) {
    for (const l of race.legs) {
      this.marketToExchange.set(l.marketId, l.exchangeId);
      this.exchangeToMarket.set(l.exchangeId, l.marketId);
    }
  }

  private async watch() {
    const listed = await this.watcher.poll();
    for (const m of listed) {
      const added = this.addLeg(m);
      if (!added) {
        log.info('new market (not a party market; ignored)', { id: m.id, title: m.title });
        continue;
      }
      const { race, leg } = added;
      this.fresh.set(leg.exchangeId, Date.now());
      log.info('new market listed', { race: race.name, party: leg.party, marketId: leg.marketId, legs: race.legs.length });
      if (race.legs.length < 2) continue; // nothing to price it against yet
      if (!this.active.includes(race)) this.active.push(race);
      this.mapLegs(race);
      this.feed.addMarkets(race.legs.map((l) => l.marketId));
      for (const l of race.legs) this.resyncQueue.add(l.exchangeId);
    }
  }

  async run() {
    const stop = async () => {
      if (!this.running) process.exit(1);
      this.running = false;
      log.info('shutting down');
      this.api.abortInFlight();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    while (this.running) {
      const started = Date.now();
      try {
        await this.cycle();
      } catch (err) {
        log.error('cycle failed', { err: err instanceof ApiError ? err.message : String(err) });
      }
      await sleep(Math.max(0, config.timing.cycleMs - (Date.now() - started)));
    }

    if (config.live) {
      try {
        const n = await this.api.cancelAll({ tournamentId: this.tournament.id });
        log.info('cancelled all orders', { cancelled: n });
      } catch (err) {
        log.error('cancel-all on shutdown failed; quotes expire on their own', { err: String(err) });
      }
    }
    await this.feed?.stop();
    process.exit(0);
  }

  private async cycle() {
    const now = Date.now();
    // A long-running process has been seen to lose every connection while a fresh one connects
    // fine. Exiting lets the supervisor start a clean process; resting quotes expire on their own.
    if (now - this.api.lastResponseAt > config.timing.networkDeadMs) {
      log.error('no response from the API; exiting so a fresh process can take over', {
        silentSec: Math.round((now - this.api.lastResponseAt) / 1000),
      });
      process.exit(75);
    }
    this.orders.prune(now);
    for (const ex of this.books.expired(now)) {
      this.books.clearExpiry(ex);
      this.resyncQueue.add(ex);
    }
    if (now - this.lastWatch > config.watch.pollMs) {
      this.lastWatch = now;
      try {
        await this.watch();
      } catch (err) {
        log.warn('market watch failed', { err: String(err) });
      }
    }
    await this.drainResyncs();
    log.debug('cycle', { resyncPending: this.resyncQueue.size, reads: this.api.reads.available() });
    if (this.needReconcile || now - this.lastReconcile > config.timing.reconcileMs) {
      try {
        await this.reconcile();
      } catch (err) {
        log.warn('reconcile failed; continuing on local state', { err: String(err) });
      }
    }
    // Sizing against positions we can't confirm is how limits get breached; stop adding risk.
    const stale = now - this.lastReconcileOk > config.timing.stalePositionsMs;
    if (stale && !this.frozen) log.warn('positions unconfirmed; only reducing orders until reconcile succeeds');
    if (!stale && this.frozen) log.info('positions confirmed; resuming');
    this.frozen = stale;

    const { desired, arbs, snipes, confirmSoon } = this.plan();
    // Unconfirmed shares are holding sizes down; a fresh snapshot frees whatever didn't fill.
    if (confirmSoon) this.needReconcile = true;
    this.logPlan(desired, arbs);
    this.logSnipes(snipes);
    if (config.live) {
      if (snipes.length) {
        await this.executeSnipes(snipes);
        return;
      }
      if (arbs.length) {
        // Arb fills change positions, so quotes are planned again next cycle from fresh state.
        for (const a of arbs) await this.executeArb(a);
        return;
      }
      await this.executeQuotes(desired);
    }
    if (now - this.lastSummary > 60_000) {
      this.lastSummary = now;
      this.summary();
    }
  }

  private async drainResyncs() {
    // REST latency swings from under a second to over ten, so fetch in parallel, and leave
    // headroom in the read budget for reconciliation.
    const budget = Math.min(this.api.reads.available() - 5, this.resyncQueue.size, config.timing.maxResyncsPerCycle);
    const batch = [...this.resyncQueue].slice(0, Math.max(0, budget));
    for (const ex of batch) this.resyncQueue.delete(ex);
    const results = await Promise.allSettled(
      batch.map(async (ex) => {
        const b = await this.api.orderbook(ex, this.tournament.id);
        // A slow response can be older than a book the feed pushed meanwhile; versions decide.
        this.books.apply(ex, b, b.asOf, null, b.asOf === null);
      }),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.resyncQueue.add(batch[i]!);
        log.warn('book resync failed', { exchangeId: batch[i], err: String(r.reason) });
      }
    });
  }

  private async reconcile() {
    // Cleared first so a feed callback asking for another reconcile mid-flight isn't lost.
    this.needReconcile = false;
    const snapshotAt = Date.now();
    const [open, pos] = await Promise.all([
      this.api.openOrders(this.tournament.id),
      this.api.positions(config.tournamentSlug),
    ]);
    this.orders.reconcile(open, snapshotAt - 15_000);
    this.positions.reconcile(pos.positions, pos.summary.totalCostBasis);
    for (const p of pos.positions) if (p.settled) this.settled.add(p.marketId);
    // The snapshot already holds fills executed before it; re-apply only the ones after.
    this.snapshotAt = snapshotAt;
    for (const f of this.recentFills) if (f.at > snapshotAt) this.positions.apply(f.exchangeId, f.side, f.qty);
    this.recentFills = this.recentFills.filter((f) => f.at > snapshotAt - 120_000);
    this.lastReconcile = Date.now();
    this.lastReconcileOk = this.lastReconcile;
    // Same listing lag as the open orders: placements just before the snapshot may be missing from it.
    this.placements.confirm(snapshotAt - 15_000, snapshotAt - 3_600_000);
  }

  private onAccount(b: AccountBatch) {
    for (const f of b.fills ?? []) {
      const id = f.orderId === null ? null : String(f.orderId);
      const placed = id ? this.placements.get(id) : undefined;
      if (!placed) {
        this.needReconcile = true;
        continue;
      }
      this.orders.fill(id!, f.quantity);
      const executedAt = (f as { executedAt?: string }).executedAt;
      const at = executedAt ? Date.parse(executedAt) : Date.now();
      const fresh = this.placements.feedFill(id!, f.quantity);
      if (fresh > 0) {
        this.recentFills.push({ at, exchangeId: placed.exchangeId, side: placed.side, qty: fresh });
        // Fills from before the last REST snapshot are already counted in it.
        if (at > this.snapshotAt) this.positions.apply(placed.exchangeId, placed.side, fresh);
      }
      log.info('fill', { exchangeId: f.exchangeId, side: placed.side, qty: f.quantity, price: f.price });
    }
    for (const u of b.orderUpdates ?? []) if (!u.open) this.orders.remove(String(u.orderId));
  }

  // ---- planning (no side effects) ----

  private plan(): { desired: Desired[]; arbs: PlannedArb[]; snipes: PlannedSnipe[]; confirmSoon: boolean } {
    const s = config.strategy;
    const desired: Desired[] = [];
    const arbs: PlannedArb[] = [];
    const snipes: PlannedSnipe[] = [];
    let confirmSoon = false;
    let budget = config.risk.maxGrossCost - this.positions.costBasis;

    for (const race of this.active) {
      if (race.legs.some((l) => this.settled.has(l.marketId))) continue;
      // A dead channel means a frozen book; quoting off it would be quoting blind. Planning no
      // quotes here makes executeQuotes pull whatever is resting.
      if (race.legs.some((l) => !this.feed.isLive(l.marketId))) {
        log.debug('skip race: feed down', { race: race.name });
        continue;
      }
      const raw = race.legs.map((l) => this.books.get(l.exchangeId));
      if (raw.some((b) => !b)) {
        log.debug('skip race: no book yet', { race: race.name });
        continue;
      }
      const ext = race.legs.map((l, i) => externalBook(raw[i]!, this.orders.forExchange(l.exchangeId)));
      const netYes = race.legs.map((l) => this.positions.get(l.exchangeId));
      // Shares that may already have filled without reaching netYes; sized as if they had.
      const isResting = (id: string) => this.orders.orders.has(id);
      const pending = {
        bid: race.legs.map((l) => this.placements.unconfirmed(l.exchangeId, 'bid', isResting)),
        ask: race.legs.map((l) => this.placements.unconfirmed(l.exchangeId, 'ask', isResting)),
      };

      // A newly listed leg is priced against the race's established legs; its opening orders can
      // sit far outside where those put it.
      const planned = this.frozen ? [] : this.planSnipes(race, ext, netYes, pending, budget);
      if (planned.length) {
        snipes.push(...planned);
        budget -= planned.reduce((a, p) => a + p.snipe.quantity * fromTicks(p.snipe.buy === 'yes' ? p.snipe.limitT : TICKS_PER_UNIT - p.snipe.limitT), 0);
        continue;
      }

      // After an arb the held books still show the liquidity it just took until fresh ones arrive,
      // so the same arb would fire again on stale state.
      const arbReady = (this.arbCooldown.get(race.name) ?? 0) <= Date.now() && !this.needReconcile && !this.frozen;
      const arb = arbReady ? findArb(ext, s.otherMaxTicks, config.arb.minEdgeTicks, config.arb.maxShares) : null;
      if (arb) {
        const room = netYes.map((q, i) =>
          arb.kind === 'sell-all' ? config.risk.maxLegShares + q - pending.ask[i]! : config.risk.maxLegShares - q - pending.bid[i]!,
        );
        const cost = arb.legs.reduce((a, l) => a + orderCost(l.side === 'bid' ? 'ask' : 'bid', l.priceT, 1), 0);
        const quantity = Math.floor(Math.min(arb.quantity, ...room, Math.max(0, budget) / cost));
        // Each arb costs several writes (cancels plus the multi-leg), so skip dust.
        if (quantity >= config.arb.minShares && quantity * fromTicks(arb.edgeTicks) >= config.arb.minProfit) {
          arbs.push({ race, arb: { ...arb, quantity } });
          budget -= quantity * cost;
          continue; // this race is re-quoted after the arb settles
        }
      }

      const touches = ext.map((b) => touch(b, s.minFairLevelQty));
      if (touches.some((t) => !t || t.askT - t.bidT > s.maxFairSpreadTicks)) {
        log.debug('skip race: touch too wide or empty', { race: race.name, touches });
        continue;
      }
      const fairs = fairValues(touches as Touch[], s.otherMaxTicks);
      const deltas = raceDeltas(netYes);

      race.legs.forEach((leg, i) => {
        const q = quoteLeg(fairs[i]!, touches[i]!, deltas[i]!, s);
        for (const side of ['bid', 'ask'] as const) {
          const priceT = side === 'bid' ? q.bidT : q.askT;
          if (priceT === null) continue;
          if ((this.cooldown.get(`${leg.exchangeId}:${side}`) ?? 0) > Date.now()) continue;
          // A bid buys back a short, an ask sells down a long: those shrink risk and free capital,
          // so they skip the capital budget and stay allowed while positions are unconfirmed.
          const reduces = side === 'bid' ? netYes[i]! < 0 : netYes[i]! > 0;
          let size = Math.min(s.quoteSize, maxOrderSize(side, netYes, pending[side], i, config.risk));
          if (pending[side][i]! > 0 && size < s.quoteSize) confirmSoon = true;
          if (reduces) size = Math.min(size, Math.abs(netYes[i]!) - pending[side][i]!);
          if (size < 1 || (this.frozen && !reduces)) continue;
          const cost = orderCost(side, priceT, size);
          if (!reduces) {
            if (cost > budget) continue;
            budget -= cost;
          }
          desired.push({ race: race.name, exchangeId: leg.exchangeId, marketId: leg.marketId, side, priceT, size });
        }
      });
    }
    return { desired, arbs, snipes, confirmSoon };
  }

  private planSnipes(
    race: Race,
    ext: ReturnType<typeof externalBook>[],
    netYes: number[],
    pending: { bid: number[]; ask: number[] },
    budget: number,
  ): PlannedSnipe[] {
    const w = config.watch;
    const now = Date.now();
    const isFresh = (ex: string) => now - (this.fresh.get(ex) ?? -Infinity) < w.snipeWindowMs;
    const out: PlannedSnipe[] = [];
    race.legs.forEach((leg, i) => {
      if (!isFresh(leg.exchangeId)) return;
      // The reference must be established legs; a race that is all new has no anchor.
      const others = race.legs.map((l, j) => ({ l, j })).filter(({ j }) => j !== i);
      if (others.some(({ l }) => isFresh(l.exchangeId))) return;
      const touches = others.map(({ j }) => touch(ext[j]!, config.strategy.minFairLevelQty));
      if (touches.some((t) => !t || t.askT - t.bidT > config.strategy.maxFairSpreadTicks)) return;
      const band = impliedBand(touches.map((t) => (t!.bidT + t!.askT) / 2), config.strategy.otherMaxTicks);
      for (const snipe of findSnipes(ext[i]!, band, w.snipeEdgeTicks, w.snipeMaxShares)) {
        const side = snipe.buy === 'yes' ? 'bid' : 'ask';
        const unitCost = fromTicks(snipe.buy === 'yes' ? snipe.limitT : TICKS_PER_UNIT - snipe.limitT);
        const quantity = Math.floor(
          Math.min(snipe.quantity, maxOrderSize(side, netYes, pending[side], i, config.risk), Math.max(0, budget) / unitCost),
        );
        if (quantity < 1) continue;
        // Profit scales down with the size cut; the walk takes the best levels first, so this is conservative.
        out.push({ race, leg, band, snipe: { ...snipe, quantity, expectedProfit: (snipe.expectedProfit * quantity) / snipe.quantity } });
      }
    });
    return out;
  }

  private logSnipes(snipes: PlannedSnipe[]) {
    for (const { race, leg, snipe, band } of snipes) {
      log.info(config.live ? 'snipe' : 'snipe (dry-run)', {
        race: race.name,
        party: leg.party,
        buy: snipe.buy,
        upToYesPrice: fromTicks(snipe.limitT),
        qty: snipe.quantity,
        band: [fromTicks(band.loT), fromTicks(band.hiT)],
        expectedProfit: +snipe.expectedProfit.toFixed(2),
      });
    }
  }

  private logPlan(desired: Desired[], arbs: PlannedArb[]) {
    for (const { race, arb } of arbs) {
      log.info(config.live ? 'arb' : 'arb (dry-run)', {
        race: race.name,
        kind: arb.kind,
        qty: arb.quantity,
        edge: fromTicks(arb.edgeTicks),
        lockedProfit: +(arb.quantity * fromTicks(arb.edgeTicks)).toFixed(2),
        prices: arb.legs.map((l) => `${race.legs[l.legIndex]!.party}@${fromTicks(l.priceT)}`),
      });
    }
    const byRace = new Map<string, string[]>();
    for (const d of desired) {
      const party = this.active.find((r) => r.name === d.race)?.legs.find((l) => l.exchangeId === d.exchangeId)?.party;
      const list = byRace.get(d.race) ?? [];
      list.push(`${party} ${d.side} ${fromTicks(d.priceT).toFixed(3)} x${d.size}`);
      byRace.set(d.race, list);
    }
    for (const [race, list] of byRace) {
      const key = list.join(' | ');
      if (this.lastPlanKey.get(race) === key) continue;
      this.lastPlanKey.set(race, key);
      if (!config.live) log.info('would quote', { race, quotes: list });
      else log.debug('quote plan', { race, quotes: list });
    }
  }

  private summary() {
    const live = [...this.orders.orders.values()];
    const exposure = this.active
      .map((r) => ({ race: r.name, net: r.legs.map((l) => `${l.party}${this.positions.get(l.exchangeId)}`).join(' ') }))
      .filter((x) => /[1-9]/.test(x.net));
    log.info('status', {
      mode: config.live ? 'LIVE' : 'dry-run',
      restingOrders: live.length,
      costBasis: +this.positions.costBasis.toFixed(2),
      readsLeft: this.api.reads.available(),
      writesLeft: this.api.writes.available(),
      positions: exposure,
    });
  }

  // ---- execution ----

  private async executeArb({ race, arb }: PlannedArb) {
    this.arbCooldown.set(race.name, Date.now() + config.arb.cooldownMs);
    for (const l of race.legs) this.resyncQueue.add(l.exchangeId);
    // Our own quotes sit inside the touch; left resting, self-trade prevention would cancel the
    // arb leg that crosses them and leave the other legs naked.
    const quoted = race.legs.filter((l) => this.orders.forExchange(l.exchangeId).length > 0);
    if (this.api.writes.available() < quoted.length + 1) return;
    for (const l of quoted) {
      await this.api.cancelAll({ tournamentId: this.tournament.id, marketId: l.marketId });
      this.orders.clear(new Set([l.exchangeId]));
    }
    const expirationDate = new Date(Date.now() + config.arb.ttlSec * 1000).toISOString();
    // sell-all hits YES bids, placed as NO buys; buy-all lifts YES asks.
    const legs: OrderRequest[] = arb.legs.map((l) => ({
      exchangeId: race.legs[l.legIndex]!.exchangeId,
      side: arb.kind === 'sell-all' ? 'no' : 'yes',
      action: 'buy',
      quantity: arb.quantity,
      price: fromTicks(arb.kind === 'sell-all' ? TICKS_PER_UNIT - l.priceT : l.priceT),
      expirationDate,
      tournamentId: this.tournament.id,
    }));
    let traded: number[] = [];
    try {
      const r = await this.api.placeMultiLeg(legs, Date.parse(expirationDate) - 5_000);
      const results = (r.results ?? []) as { index: number; data: OrderResult & { remainingQuantity?: number } }[];
      traded = legs.map(() => 0);
      for (const { index, data } of results) {
        this.track(legs[index]!, data, 'arb');
        traded[index] = legs[index]!.quantity - (data.remainingQuantity ?? legs[index]!.quantity - (data.quantityTraded ?? 0));
      }
      log.info('arb placed', { race: race.name, kind: arb.kind, qty: arb.quantity, traded });
    } catch (err) {
      log.warn('arb failed', { race: race.name, err: String(err) });
      if (mayHavePlaced(err)) for (const l of legs) this.unknownOutcome(l);
      this.needReconcile = true;
      return;
    }
    this.needReconcile = true;
    // Placement is atomic, filling is not. Uneven legs leave a one-sided position: pull the
    // remainders so it can't grow, and let the inventory skew work the excess off.
    if (Math.max(...traded) !== Math.min(...traded)) {
      log.warn('arb legs filled unevenly', { race: race.name, traded });
      for (const l of race.legs) {
        try {
          await this.api.cancelAll({ tournamentId: this.tournament.id, marketId: l.marketId });
          this.orders.clear(new Set([l.exchangeId]));
        } catch (err) {
          log.error('cancel after uneven arb failed; legs expire in seconds', { market: l.marketId, err: String(err) });
        }
      }
    }
  }

  private async executeSnipes(snipes: PlannedSnipe[]) {
    if (this.api.writes.available() < 1) return;
    // Short expiry: whatever isn't taken immediately shouldn't rest as a stale order.
    const expirationDate = new Date(Date.now() + config.arb.ttlSec * 1000).toISOString();
    const reqs: OrderRequest[] = snipes.map(({ leg, snipe }) => ({
      exchangeId: leg.exchangeId,
      side: snipe.buy,
      action: 'buy',
      quantity: snipe.quantity,
      price: fromTicks(snipe.buy === 'yes' ? snipe.limitT : TICKS_PER_UNIT - snipe.limitT),
      expirationDate,
      tournamentId: this.tournament.id,
    }));
    try {
      const r = await this.api.placeBatch(reqs, Date.parse(expirationDate) - 5_000);
      for (const item of r.results ?? []) {
        if (item.ok) this.track(reqs[item.index]!, item.data as OrderResult & { remainingQuantity?: number }, 'snipe');
        else if (item.status === 429 || item.status >= 500) this.unknownOutcome(reqs[item.index]!);
        else log.warn('snipe rejected', { exchangeId: reqs[item.index]?.exchangeId, status: item.status, data: item.data });
      }
      log.info('snipes placed', { count: reqs.length });
    } catch (err) {
      log.warn('snipe batch failed', { err: String(err) });
      if (mayHavePlaced(err)) for (const req of reqs) this.unknownOutcome(req);
    }
    this.needReconcile = true;
  }

  private async executeQuotes(desired: Desired[]) {
    const s = config.strategy;
    const now = Date.now();
    const byEx = new Map<string, Desired[]>();
    for (const d of desired) byEx.set(d.exchangeId, [...(byEx.get(d.exchangeId) ?? []), d]);
    const exchanges = new Set([...byEx.keys(), ...[...this.orders.orders.values()].filter((o) => o.kind === 'quote').map((o) => o.exchangeId)]);

    const cancelEx = new Set<string>();
    const placeOnly: Desired[] = [];
    for (const ex of exchanges) {
      const want = byEx.get(ex) ?? [];
      const have = this.orders.forExchange(ex).filter((o) => o.kind === 'quote');
      let stale = false;
      const missing: Desired[] = [];
      for (const side of ['bid', 'ask'] as const) {
        const w = want.find((d) => d.side === side);
        const h = have.filter((o) => o.side === side);
        const cur = h[0];
        if (h.length > 1 || (!w && cur)) stale = true;
        if (w && !cur) missing.push(w);
        if (
          w &&
          cur &&
          (Math.abs(w.priceT - cur.priceT) >= s.requoteThresholdTicks || remaining(cur) < w.size / 2 || remaining(cur) > w.size)
        )
          stale = true;
      }
      if (stale) cancelEx.add(ex);
      else placeOnly.push(...missing);
    }
    if (!cancelEx.size && !placeOnly.length) return;

    // Either cancel each stale market, or cancel everything once and re-place the full set.
    const perMarketPlace = [...placeOnly, ...[...cancelEx].flatMap((ex) => byEx.get(ex) ?? [])];
    const perMarketCost = cancelEx.size + Math.ceil(perMarketPlace.length / config.timing.batchSize);
    const globalCost = 1 + Math.ceil(desired.length / config.timing.batchSize);
    const useGlobal = cancelEx.size > 1 && globalCost < perMarketCost;
    let toPlace = useGlobal ? desired : perMarketPlace;

    // Cancels come first: a stale quote resting is worse than a missing one.
    if (cancelEx.size) {
      const cancelCost = useGlobal ? 1 : cancelEx.size;
      if (this.api.writes.available() < Math.min(cancelCost, 1)) return;
      if (useGlobal) {
        await this.api.cancelAll({ tournamentId: this.tournament.id });
        this.orders.clear();
      } else {
        const done = new Set<string>();
        for (const ex of cancelEx) {
          if (this.api.writes.available() < 1) break;
          const marketId = this.exchangeToMarket.get(ex);
          if (!marketId) continue;
          await this.api.cancelAll({ tournamentId: this.tournament.id, marketId });
          this.orders.clear(new Set([ex]));
          done.add(ex);
        }
        // Don't stack new quotes on markets whose old ones are still resting.
        toPlace = toPlace.filter((d) => !cancelEx.has(d.exchangeId) || done.has(d.exchangeId));
      }
    }

    const batches = Math.min(Math.ceil(toPlace.length / config.timing.batchSize), this.api.writes.available());
    if (batches < Math.ceil(toPlace.length / config.timing.batchSize)) log.debug('write budget short; placing part of the quotes', { batches });
    const expirationDate = new Date(now + config.timing.quoteTtlSec * 1000).toISOString();
    // In parallel: sent one after another, a slow first batch ate the shared deadline and the rest
    // were dropped unsent.
    const placeChunk = async (b: number) => {
      const chunk = toPlace.slice(b * config.timing.batchSize, (b + 1) * config.timing.batchSize);
      const reqs: OrderRequest[] = chunk.map((d) => ({
        exchangeId: d.exchangeId,
        side: d.side === 'bid' ? 'yes' : 'no',
        action: 'buy',
        quantity: d.size,
        price: fromTicks(d.side === 'bid' ? d.priceT : TICKS_PER_UNIT - d.priceT),
        expirationDate,
        tournamentId: this.tournament.id,
      }));
      try {
        // Give up once the quotes would land with under 10s to live; reconcile picks up any that rested.
        const r = await this.api.placeBatch(reqs, Date.parse(expirationDate) - 10_000);
        let ok = 0;
        for (const item of r.results ?? []) {
          const req = reqs[item.index]!;
          if (item.ok) {
            ok++;
            this.track(req, item.data as OrderResult & { remainingQuantity?: number }, 'quote');
          } else if (item.status === 429 || item.status >= 500) {
            // Outcome unknown (a 502 may have rested); the listing will tell us.
            this.unknownOutcome(req);
          } else {
            log.warn('quote rejected', { exchangeId: req.exchangeId, status: item.status, data: item.data });
            this.cooldown.set(`${req.exchangeId}:${req.side === 'yes' ? 'bid' : 'ask'}`, now + 60_000);
          }
        }
        log.debug('quotes placed', { ok, total: reqs.length });
      } catch (err) {
        log.warn('batch failed', { err: String(err) });
        if (mayHavePlaced(err)) for (const req of reqs) this.unknownOutcome(req);
        this.needReconcile = true;
      }
    };
    await Promise.all(Array.from({ length: batches }, (_, b) => placeChunk(b)));
  }

  // An order that may or may not be on the book (timeout, 5xx, abandoned retry): it counts as
  // filled against the limits until a snapshot taken after it says otherwise.
  private unknownOutcome(req: OrderRequest) {
    this.placements.record(null, { exchangeId: req.exchangeId, side: req.side === 'yes' ? 'bid' : 'ask', quantity: req.quantity, traded: 0, at: Date.now() });
    this.needReconcile = true;
  }

  private track(req: OrderRequest, data: OrderResult & { remainingQuantity?: number }, kind: OwnOrder['kind']) {
    const id = data.orderId ?? data.id;
    if (id === undefined || id === null) {
      this.unknownOutcome(req);
      return;
    }
    const side: 'bid' | 'ask' = req.side === 'yes' ? 'bid' : 'ask';
    const priceT = side === 'bid' ? toTicks(req.price) : TICKS_PER_UNIT - toTicks(req.price);
    const left = data.remainingQuantity ?? req.quantity - (data.quantityTraded ?? 0);
    const now = Date.now();
    // Credit a fill on placement now; waiting for the feed or the next snapshot is how one leg
    // got quoted again and again while every quote filled.
    const traded = this.placements.record(String(id), { exchangeId: req.exchangeId, side, quantity: req.quantity, traded: req.quantity - left, at: now });
    if (traded > 0) {
      this.positions.apply(req.exchangeId, side, traded);
      this.recentFills.push({ at: now, exchangeId: req.exchangeId, side, qty: traded });
    }
    if (data.open === false || left <= 0) return;
    this.orders.add({
      id: String(id),
      exchangeId: req.exchangeId,
      side,
      priceT,
      quantity: req.quantity,
      filled: req.quantity - left,
      feedFilled: 0,
      placedAt: Date.now(),
      expiresAt: req.expirationDate ? Date.parse(req.expirationDate) : Infinity,
      kind,
    });
  }
}

// A 4xx other than 409 means the request was refused and placed nothing; anything else (timeout,
// abandoned retry, 5xx, 409 still in flight) may have placed some or all of it.
function mayHavePlaced(err: unknown): boolean {
  return !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 409);
}
