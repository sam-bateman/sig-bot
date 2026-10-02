// Read-only scan: every race ranked by how contested it is, plus locked-profit opportunities
// visible at the top of the bulk quote snapshot. Places no orders.
import { Api, ApiError, type Quote } from '../api.js';
import { config, TICKS_PER_UNIT } from '../config.js';
import { fairValues, fromTicks, raceScore, toTicks, type Touch } from '../strategy.js';
import { buildRaces, type Party, type Race } from '../universe.js';

const PARTIES: Party[] = ['R', 'D', 'I'];
const TOP_N = 5;

interface Row {
  race: Race;
  bids: (number | null)[]; // ticks, per leg
  asks: (number | null)[];
  fairs: number[] | null; // ticks, per leg
  score: number | null;
}

interface Opp {
  race: Race;
  kind: 'sell-all' | 'buy-all';
  edgeTicks: number;
}

const price = (t: number | null) => (t === null ? '-' : fromTicks(t).toFixed(3));
const cents = (ticks: number) => ((ticks / TICKS_PER_UNIT) * 100).toFixed(1);
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function table(header: string[], rows: string[][], left: number[] = [0]) {
  const w = header.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  const fmt = (r: string[]) => r.map((v, c) => (left.includes(c) ? v.padEnd(w[c]!) : v.padStart(w[c]!))).join('  ');
  console.log(fmt(header));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

function sumAll(xs: (number | null)[]): number | null {
  return xs.every((x): x is number => x !== null) ? xs.reduce((a, b) => a + b, 0) : null;
}

function analyse(race: Race, quotes: Map<string, Quote>): Row {
  const bids = race.legs.map((l) => {
    const b = quotes.get(l.exchangeId)?.bestBid;
    return b === null || b === undefined ? null : toTicks(b);
  });
  const asks = race.legs.map((l) => {
    const a = quotes.get(l.exchangeId)?.bestAsk;
    return a === null || a === undefined ? null : toTicks(a);
  });
  // Same inputs the engine uses to pick races, so the ranking matches what it would quote.
  if (bids.some((b) => b === null) || asks.some((a) => a === null)) return { race, bids, asks, fairs: null, score: null };
  const touches: Touch[] = race.legs.map((_, i) => ({ bidT: bids[i]!, askT: asks[i]! }));
  const fairs = fairValues(touches, config.strategy.otherMaxTicks);
  return { race, bids, asks, fairs, score: raceScore(fairs) };
}

function opportunities(rows: Row[]): Opp[] {
  const out: Opp[] = [];
  for (const { race, bids, asks } of rows) {
    const sb = sumAll(bids);
    const sa = sumAll(asks);
    if (sb !== null && sb > TICKS_PER_UNIT) out.push({ race, kind: 'sell-all', edgeTicks: sb - TICKS_PER_UNIT });
    if (sa !== null && sa < TICKS_PER_UNIT - config.strategy.otherMaxTicks) {
      out.push({ race, kind: 'buy-all', edgeTicks: TICKS_PER_UNIT - config.strategy.otherMaxTicks - sa });
    }
  }
  return out.sort((a, b) => b.edgeTicks - a.edgeTicks);
}

async function main() {
  const api = new Api();
  const t = await api.tournament(config.tournamentSlug);
  const markets = await api.tournamentMarkets(config.tournamentSlug);
  const { races, unmatched } = buildRaces(markets);
  const ids = races.flatMap((r) => r.legs.map((l) => l.exchangeId));
  const quotes = new Map((await api.quotes(ids, t.id)).map((q) => [q.exchangeId, q]));

  const rows = races.map((r) => analyse(r, quotes));
  // Most contested first (score is distance of the favourite from 50%); unquoted races last.
  rows.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || a.race.name.localeCompare(b.race.name));

  console.log(`${t.name} (${t.slug}), status ${t.status}`);
  console.log(
    `${markets.length} markets, ${races.length} races, ${unmatched.length} markets outside a race, ` +
      `${rows.filter((r) => r.fairs).length} races fully quoted. Prices are YES, 0-1; fair uses otherMax ${config.strategy.otherMaxTicks} ticks.`,
  );
  console.log('');

  const header = ['Race', ...PARTIES.map((p) => `${p} bid/ask`), 'Sum bids', 'Sum asks', ...PARTIES.map((p) => `Fair ${p}`), 'Score'];
  const body = rows.map((r) => {
    const leg = (p: Party) => {
      const i = r.race.legs.findIndex((l) => l.party === p);
      return i < 0 ? '' : `${price(r.bids[i]!)}/${price(r.asks[i]!)}`;
    };
    const fair = (p: Party) => {
      const i = r.race.legs.findIndex((l) => l.party === p);
      return i < 0 || !r.fairs ? '' : fromTicks(r.fairs[i]!).toFixed(3);
    };
    const sb = sumAll(r.bids);
    const sa = sumAll(r.asks);
    return [
      r.race.name,
      ...PARTIES.map(leg),
      sb === null ? '-' : price(sb),
      sa === null ? '-' : price(sa),
      ...PARTIES.map(fair),
      r.score === null ? '-' : fromTicks(r.score).toFixed(3),
    ];
  });
  table(header, body, [0]);

  console.log('');
  const opps = opportunities(rows);
  console.log(
    `Locked-profit opportunities at top of book (sell-all: sum bids > 1; buy-all: sum asks < ${price(TICKS_PER_UNIT - config.strategy.otherMaxTicks)}): ${opps.length}`,
  );
  if (!opps.length) return;

  table(
    ['Race', 'Kind', 'Edge (cents/share)'],
    opps.map((o) => [o.race.name, o.kind, cents(o.edgeTicks)]),
    [0, 1],
  );

  // The bulk snapshot has no sizes; read the full book for the best few only.
  console.log('');
  console.log(`Top ${Math.min(TOP_N, opps.length)} by edge, checked against the live orderbook (quantity is the smallest top-level size across legs):`);
  const detail: string[][] = [];
  for (const o of opps.slice(0, TOP_N)) {
    const books = [];
    for (const leg of o.race.legs) books.push(await api.orderbook(leg.exchangeId, t.id));
    const tops = books.map((b) => {
      const level = o.kind === 'sell-all'
        ? [...b.bids].sort((x, y) => y.price - x.price)[0]
        : [...b.asks].sort((x, y) => x.price - y.price)[0];
      return level ?? null;
    });
    if (tops.some((l) => l === null)) {
      detail.push([o.race.name, o.kind, 'empty side', '-', '-', '-']);
      continue;
    }
    const sum = tops.reduce((a, l) => a + toTicks(l!.price), 0);
    const edgeTicks =
      o.kind === 'sell-all' ? sum - TICKS_PER_UNIT : TICKS_PER_UNIT - config.strategy.otherMaxTicks - sum;
    const qty = Math.min(...tops.map((l) => l!.quantity));
    const prices = o.race.legs.map((l, i) => `${l.party}@${price(toTicks(tops[i]!.price))}`).join(' ');
    detail.push([
      o.race.name,
      o.kind,
      prices,
      edgeTicks > 0 ? cents(edgeTicks) : 'gone',
      String(qty),
      edgeTicks > 0 ? money(qty * fromTicks(edgeTicks)) : '-',
    ]);
  }
  table(['Race', 'Kind', 'Top-level prices', 'Edge (cents)', 'Lockable qty', 'Locked profit'], detail, [0, 1, 2]);
  console.log('');
  console.log('Locked profit = lockable qty x edge. Buy-all edge is measured against 1 - otherMax, so it is only locked if no unlisted party wins.');
}

main().catch((err) => {
  console.error(err instanceof ApiError ? err.message : err);
  process.exit(1);
});
