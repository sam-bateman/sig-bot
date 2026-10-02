import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaces, parseLeg } from '../src/universe.js';
import type { Market } from '../src/api.js';

let n = 0;
const market = (title: string, over: Partial<Market> = {}): Market => {
  n++;
  return {
    id: `m${n}`,
    title,
    status: 'open',
    exchanges: [{ id: `e${n}`, option: 'Yes', latestPrice: null }],
    ...over,
  };
};
const party = (p: 'Republican' | 'Democratic' | 'Independent', race: string, over: Partial<Market> = {}) =>
  market(`Will the ${p} Party win the ${race}?`, over);

describe('buildRaces', () => {
  it('groups party markets by race name', () => {
    const { races, unmatched } = buildRaces([
      party('Republican', 'Texas Senate race'),
      party('Democratic', 'Texas Senate race'),
      party('Republican', 'Ohio Senate race'),
      party('Democratic', 'Ohio Senate race'),
    ]);
    assert.equal(unmatched.length, 0);
    assert.deepEqual(races.map((r) => r.name), ['Ohio Senate race', 'Texas Senate race']);
    assert.ok(races.every((r) => r.legs.length === 2));
  });

  it('builds legs with party, ids and title', () => {
    const r = party('Republican', 'Texas Senate race');
    const d = party('Democratic', 'Texas Senate race');
    const { races } = buildRaces([r, d]);
    assert.deepEqual(races[0]!.legs[0], {
      party: 'R',
      marketId: r.id,
      exchangeId: r.exchanges[0]!.id,
      title: r.title,
    });
    assert.equal(races[0]!.legs[1]!.party, 'D');
    assert.equal(races[0]!.legs[1]!.exchangeId, d.exchanges[0]!.id);
  });

  it('orders legs R, D, I regardless of input order', () => {
    const { races } = buildRaces([
      party('Independent', 'Maine Senate race'),
      party('Democratic', 'Maine Senate race'),
      party('Republican', 'Maine Senate race'),
    ]);
    assert.deepEqual(races[0]!.legs.map((l) => l.party), ['R', 'D', 'I']);
  });

  it('supports an R/I or D/I pair', () => {
    const { races } = buildRaces([
      party('Independent', 'A'),
      party('Republican', 'A'),
      party('Independent', 'B'),
      party('Democratic', 'B'),
    ]);
    assert.deepEqual(races.map((r) => r.legs.map((l) => l.party)), [['R', 'I'], ['D', 'I']]);
  });

  it('drops races with fewer than two legs', () => {
    const lone = party('Republican', 'Lonely race');
    const { races, unmatched } = buildRaces([lone, party('Republican', 'A'), party('Democratic', 'A')]);
    assert.deepEqual(races.map((r) => r.name), ['A']);
    // a lone leg is dropped silently; it is matched, so it is not "unmatched"
    assert.equal(unmatched.includes(lone), false);
  });

  it('puts non-matching titles in unmatched', () => {
    const odd = market('Will it rain tomorrow?');
    const wrongParty = market('Will the Green Party win the Texas Senate race?');
    const noQuestion = market('Will the Republican Party win the Texas Senate race');
    const { races, unmatched } = buildRaces([odd, wrongParty, noQuestion]);
    assert.equal(races.length, 0);
    assert.deepEqual(unmatched, [odd, wrongParty, noQuestion]);
  });

  it('puts non-open markets in unmatched and excludes them from races', () => {
    const closed = party('Republican', 'A', { status: 'closed' });
    const { races, unmatched } = buildRaces([closed, party('Republican', 'A'), party('Democratic', 'A')]);
    assert.deepEqual(unmatched, [closed]);
    assert.equal(races[0]!.legs.length, 2);
    assert.ok(races[0]!.legs.every((l) => l.marketId !== closed.id));
  });

  it('a closed leg leaves its partner alone, so the race is dropped', () => {
    const { races, unmatched } = buildRaces([party('Republican', 'A'), party('Democratic', 'A', { status: 'resolved' })]);
    assert.equal(races.length, 0);
    assert.equal(unmatched.length, 1);
  });

  it('puts multi-exchange and zero-exchange markets in unmatched', () => {
    const multi = party('Republican', 'A', {
      exchanges: [
        { id: 'x1', option: 'Yes', latestPrice: null },
        { id: 'x2', option: 'No', latestPrice: null },
      ],
    });
    const none = party('Democratic', 'A', { exchanges: [] });
    const { races, unmatched } = buildRaces([multi, none, party('Independent', 'A')]);
    assert.deepEqual(unmatched, [multi, none]);
    assert.equal(races.length, 0); // only one usable leg remains
  });

  it('drops a race where the same party appears twice', () => {
    const { races } = buildRaces([party('Republican', 'A'), party('Republican', 'A'), party('Democratic', 'A')]);
    assert.equal(races.length, 0);
  });

  it('captures race names containing punctuation and digits', () => {
    const { races } = buildRaces([party('Republican', "NY-12 House race (special)"), party('Democratic', "NY-12 House race (special)")]);
    assert.equal(races[0]!.name, 'NY-12 House race (special)');
  });

  it('is case sensitive about the title', () => {
    const { races, unmatched } = buildRaces([
      market('will the republican party win the A?'),
      market('will the democratic party win the A?'),
    ]);
    assert.equal(races.length, 0);
    assert.equal(unmatched.length, 2);
  });

  it('handles an empty market list', () => {
    assert.deepEqual(buildRaces([]), { races: [], unmatched: [] });
  });

  it('sorts races by name', () => {
    const { races } = buildRaces([
      party('Republican', 'Zed'),
      party('Democratic', 'Zed'),
      party('Republican', 'Alpha'),
      party('Democratic', 'Alpha'),
      party('Republican', 'Mid'),
      party('Democratic', 'Mid'),
    ]);
    assert.deepEqual(races.map((r) => r.name), ['Alpha', 'Mid', 'Zed']);
  });
});

describe('parseLeg', () => {
  it('parses Republican party market', () => {
    const m = party('Republican', 'Texas Senate race');
    const result = parseLeg(m);
    assert.ok(result);
    assert.equal(result.name, 'Texas Senate race');
    assert.equal(result.leg.party, 'R');
    assert.equal(result.leg.marketId, m.id);
    assert.equal(result.leg.exchangeId, m.exchanges[0]!.id);
    assert.equal(result.leg.title, m.title);
  });

  it('parses Democratic party market', () => {
    const m = party('Democratic', 'Ohio House race');
    const result = parseLeg(m);
    assert.ok(result);
    assert.equal(result.leg.party, 'D');
  });

  it('parses Independent party market', () => {
    const m = party('Independent', 'Maine Senate race');
    const result = parseLeg(m);
    assert.ok(result);
    assert.equal(result.leg.party, 'I');
  });

  it('returns null for non-matching title', () => {
    const m = market('Will it rain tomorrow?');
    assert.equal(parseLeg(m), null);
  });

  it('returns null for title with wrong case', () => {
    const m = market('will the republican party win the Texas Senate?');
    assert.equal(parseLeg(m), null);
  });

  it('returns null for title missing question mark', () => {
    const m = market('Will the Republican Party win the Texas Senate race');
    assert.equal(parseLeg(m), null);
  });

  it('returns null for wrong party name', () => {
    const m = market('Will the Green Party win the Texas Senate race?');
    assert.equal(parseLeg(m), null);
  });

  it('returns null for closed market', () => {
    const m = party('Republican', 'Texas Senate race', { status: 'closed' });
    assert.equal(parseLeg(m), null);
  });

  it('returns null for resolved market', () => {
    const m = party('Democratic', 'Texas Senate race', { status: 'resolved' });
    assert.equal(parseLeg(m), null);
  });

  it('returns null for zero exchanges', () => {
    const m = party('Republican', 'Texas Senate race', { exchanges: [] });
    assert.equal(parseLeg(m), null);
  });

  it('returns null for multiple exchanges', () => {
    const m = party('Republican', 'Texas Senate race', {
      exchanges: [
        { id: 'e1', option: 'Yes', latestPrice: null },
        { id: 'e2', option: 'No', latestPrice: null },
      ],
    });
    assert.equal(parseLeg(m), null);
  });

  it('captures race name with punctuation and digits', () => {
    const m = market('Will the Republican Party win the NY-12 House race (special)?', {
      exchanges: [{ id: 'e1', option: 'Yes', latestPrice: null }],
    });
    const result = parseLeg(m);
    assert.ok(result);
    assert.equal(result.name, 'NY-12 House race (special)');
  });

  it('leg carries the correct market and exchange ids', () => {
    n = 100;
    const m = party('Republican', 'Test Race');
    const result = parseLeg(m);
    assert.ok(result);
    assert.equal(result.leg.marketId, 'm101');
    assert.equal(result.leg.exchangeId, 'e101');
  });
});
