import type { Market } from './api.js';

export type Party = 'R' | 'D' | 'I';

export interface Leg {
  party: Party;
  marketId: string;
  exchangeId: string;
  title: string;
}

// One contest (e.g. "Texas Senate") and every party market listed for it.
// At most one leg can settle YES.
export interface Race {
  name: string;
  legs: Leg[];
}

const TITLE = /^Will the (Republican|Democratic|Independent) Party win the (.+)\?$/;
const PARTY: Record<string, Party> = { Republican: 'R', Democratic: 'D', Independent: 'I' };

// The race and leg a market belongs to, or null when it isn't an open single-exchange party market.
export function parseLeg(m: Market): { name: string; leg: Leg } | null {
  const match = TITLE.exec(m.title);
  const ex = m.exchanges[0];
  if (!match || m.exchanges.length !== 1 || !ex || m.status !== 'open') return null;
  const [, party, name] = match as unknown as [string, string, string];
  return { name, leg: { party: PARTY[party]!, marketId: m.id, exchangeId: ex.id, title: m.title } };
}

export function buildRaces(markets: Market[]): { races: Race[]; unmatched: Market[] } {
  const byName = new Map<string, Leg[]>();
  const unmatched: Market[] = [];
  for (const m of markets) {
    const parsed = parseLeg(m);
    if (!parsed) {
      unmatched.push(m);
      continue;
    }
    const legs = byName.get(parsed.name) ?? [];
    legs.push(parsed.leg);
    byName.set(parsed.name, legs);
  }
  const races: Race[] = [];
  for (const [name, legs] of byName) {
    // A lone market has no partner to price against.
    if (legs.length < 2 || new Set(legs.map((l) => l.party)).size !== legs.length) continue;
    legs.sort((a, b) => 'RDI'.indexOf(a.party) - 'RDI'.indexOf(b.party));
    races.push({ name, legs });
  }
  races.sort((a, b) => a.name.localeCompare(b.name));
  return { races, unmatched };
}
