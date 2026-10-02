// Spots markets that join the tournament after startup. There is no realtime event for a new
// listing, so this diffs the full market list on a timer. A market can be added to a tournament
// long after it was created, so watching only the newest page would miss it.
import type { Api, Market } from './api.js';

export function newMarkets(known: ReadonlySet<string>, listed: Market[]): Market[] {
  return listed.filter((m) => !known.has(m.id) && m.status === 'open');
}

export class MarketWatcher {
  private readonly known: Set<string>;

  constructor(
    private readonly api: Api,
    private readonly slug: string,
    initial: Market[],
  ) {
    this.known = new Set(initial.map((m) => m.id));
  }

  async poll(): Promise<Market[]> {
    const fresh = newMarkets(this.known, await this.api.tournamentMarkets(this.slug));
    for (const m of fresh) this.known.add(m.id);
    return fresh;
  }
}
