// Read-only account snapshot: balance, resting orders, positions grouped by race, P&L, leaderboard.
import { Api, ApiError, type Position, type RestOrder } from '../api.js';
import { config } from '../config.js';
import { toYes } from '../state.js';
import { toTicks } from '../strategy.js';
import { buildRaces, type Race } from '../universe.js';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => (n > 0 ? '+' : '') + money(n);
const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function table(header: string[], rows: string[][], left: number[] = [0]) {
  const w = header.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  const fmt = (r: string[]) => r.map((v, c) => (left.includes(c) ? v.padEnd(w[c]!) : v.padStart(w[c]!))).join('  ');
  console.log(fmt(header));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

function heading(s: string) {
  console.log('');
  console.log(s);
}

// Net YES shares: YES lots count up, NO lots down. Falls back to the aggregate quantity.
function netYes(p: Position): number {
  return p.lots.length ? p.lots.reduce((a, l) => a + (l.side.toLowerCase() === 'yes' ? l.quantity : -l.quantity), 0) : p.quantity;
}

function printValue(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function main() {
  const api = new Api();
  const slug = config.tournamentSlug;
  const t = await api.tournament(slug);
  const [markets, open, pos, pnl, lb] = await Promise.all([
    api.tournamentMarkets(slug),
    api.openOrders(t.id),
    api.positions(slug),
    api.pnl(slug),
    api.leaderboard(slug),
  ]);
  const { races } = buildRaces(markets);

  const legOf = new Map<string, { race: Race; party: string }>();
  for (const race of races) for (const l of race.legs) legOf.set(l.exchangeId, { race, party: l.party });
  const label = (ex: string, fallback?: string) => {
    const l = legOf.get(ex);
    return l ? `${l.race.name} (${l.party})` : (fallback ?? `exchange ${ex}`);
  };

  console.log(`${t.name} (${t.slug})  status ${t.status}  ends ${t.endDate}`);
  console.log(`Balance: ${money(t.myBalance)}`);

  // ---- open orders ----
  heading(`Open orders: ${open.length}`);
  if (open.length) {
    const byEx = new Map<string, RestOrder[]>();
    for (const o of open) byEx.set(o.exchangeId, [...(byEx.get(o.exchangeId) ?? []), o]);
    const rows = [...byEx]
      .map(([ex, os]) => {
        const sides = os.map((o) => toYes(o.side, o.action, o.priceLimit === null ? 0 : toTicks(o.priceLimit)).side);
        return [label(ex), String(os.length), String(sides.filter((s) => s === 'bid').length), String(sides.filter((s) => s === 'ask').length), qtyFmt(os.reduce((a, o) => a + o.quantity, 0))];
      })
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    table(['Exchange', 'Orders', 'Bids', 'Asks', 'Total qty'], rows, [0]);
  }

  // ---- positions ----
  const held = pos.positions;
  heading(`Positions: ${held.length}`);
  if (held.length) {
    const rows = held
      .map((p) => {
        const net = netYes(p);
        return [
          label(p.exchangeId, p.marketTitle),
          qtyFmt(net),
          money(p.costBasis),
          p.currentPrice === null ? '-' : p.currentPrice.toFixed(3),
          signed(p.unrealizedPnl),
          p.settled ? 'settled' : '',
        ];
      })
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    table(['Market', 'Net YES', 'Cost basis', 'Price', 'Unrealized', ''], rows, [0, 5]);
    console.log(
      `Total: cost basis ${money(pos.summary.totalCostBasis)}, market value ${money(pos.summary.totalMarketValue)}, unrealized ${signed(pos.summary.totalUnrealizedPnl)}`,
    );

    // Per race: net YES on each leg. Equal YES on every leg is flat, so spread is the directional risk.
    heading('Net exposure by race (unsettled)');
    const byRace = new Map<string, Position[]>();
    const other: Position[] = [];
    for (const p of held) {
      if (p.settled) continue;
      const l = legOf.get(p.exchangeId);
      if (!l) other.push(p);
      else byRace.set(l.race.name, [...(byRace.get(l.race.name) ?? []), p]);
    }
    const raceRows: string[][] = [];
    for (const [name, ps] of byRace) {
      const race = races.find((r) => r.name === name)!;
      const nets = race.legs.map((l) => {
        const p = ps.find((x) => x.exchangeId === l.exchangeId);
        return p ? netYes(p) : 0;
      });
      const parts = race.legs.map((l, i) => `${l.party} ${qtyFmt(nets[i]!)}`).join('  ');
      raceRows.push([
        name,
        parts,
        qtyFmt(Math.max(...nets) - Math.min(...nets)),
        money(ps.reduce((a, p) => a + p.costBasis, 0)),
        signed(ps.reduce((a, p) => a + p.unrealizedPnl, 0)),
      ]);
    }
    if (raceRows.length) table(['Race', 'Net YES by leg', 'Spread', 'Cost basis', 'Unrealized'], raceRows.sort((a, b) => a[0]!.localeCompare(b[0]!)), [0, 1]);
    else console.log('(none)');
    if (other.length) {
      console.log(`Outside any race: ${other.map((p) => `${p.marketTitle} ${qtyFmt(netYes(p))}`).join('; ')}`);
    }
  }

  // ---- pnl ----
  heading('P&L');
  for (const [k, v] of Object.entries(pnl)) console.log(`  ${k.padEnd(20)} ${printValue(v)}`);

  // ---- leaderboard ----
  const entries = Array.isArray((lb as { leaderboard?: unknown }).leaderboard) ? ((lb as { leaderboard: Record<string, unknown>[] }).leaderboard) : null;
  heading(`Leaderboard (period ${printValue(lb.period)}, ${printValue(lb.total)} ranked)`);
  if (entries) {
    const keys = ['pnl', 'roi', 'volume', 'tradesCount', 'winRate', 'finalTotalValue', 'finalBalance'].filter((k) => entries.some((e) => e[k] !== undefined));
    const rows = entries.slice(0, 10).map((e) => [
      String(e.rank ?? '-'),
      String(e.username ?? e.profileId ?? '-'),
      ...keys.map((k) => (typeof e[k] === 'number' ? (k === 'tradesCount' ? (e[k] as number).toLocaleString('en-US') : k === 'roi' || k === 'winRate' ? (e[k] as number).toFixed(2) : money(e[k] as number)) : '-')),
    ]);
    if (rows.length) table(['Rank', 'User', ...keys], rows, [1]);
    else console.log('(empty)');
  } else {
    console.log(`unexpected shape, keys: ${Object.keys(lb).join(', ')}`);
  }
  console.log(`My rank: ${lb.myRank === null || lb.myRank === undefined ? 'not ranked' : printValue(lb.myRank)}`);
}

main().catch((err) => {
  console.error(err instanceof ApiError ? err.message : err);
  process.exit(1);
});
