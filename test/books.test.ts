import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BookStore, isNewer } from '../src/books.js';
import type { AsOf } from '../src/api.js';

const asOf = (sequence: number, at = '2026-10-02T02:20:34.0819381+00:00'): AsOf => ({ sequence, at });
const raw = (bid = 0.45, ask = 0.5) => ({ bids: [{ price: bid, quantity: 100 }], asks: [{ price: ask, quantity: 80 }] });

describe('isNewer', () => {
  it('replaces a null held book with anything', () => {
    assert.equal(isNewer(asOf(1), null), true);
    assert.equal(isNewer(null, null), true);
  });

  it('never replaces a versioned book with an unversioned one', () => {
    assert.equal(isNewer(null, asOf(1)), false);
  });

  it('compares sequence first', () => {
    assert.equal(isNewer(asOf(5), asOf(4)), true);
    assert.equal(isNewer(asOf(4), asOf(5)), false);
  });

  it('sequence wins over timestamp', () => {
    assert.equal(isNewer(asOf(5, '2026-01-01T00:00:00+00:00'), asOf(4, '2026-12-01T00:00:00+00:00')), true);
    assert.equal(isNewer(asOf(4, '2026-12-01T00:00:00+00:00'), asOf(5, '2026-01-01T00:00:00+00:00')), false);
  });

  it('breaks sequence ties on the timestamp', () => {
    assert.equal(isNewer(asOf(5, '2026-10-02T02:20:35+00:00'), asOf(5, '2026-10-02T02:20:34+00:00')), true);
    assert.equal(isNewer(asOf(5, '2026-10-02T02:20:34+00:00'), asOf(5, '2026-10-02T02:20:35+00:00')), false);
  });

  it('an identical version is not newer', () => {
    assert.equal(isNewer(asOf(5), asOf(5)), false);
  });

  describe('engine timestamps with 7 fractional digits', () => {
    const t = (frac: string) => `2026-10-02T02:20:34.${frac}+00:00`;

    it('Date.parse reads the format', () => {
      assert.ok(Number.isFinite(Date.parse(t('0819381'))));
      assert.equal(Date.parse(t('0819381')), Date.parse('2026-10-02T02:20:34.081Z'));
    });

    it('orders timestamps that differ by at least a millisecond', () => {
      assert.equal(isNewer(asOf(1, t('0829381')), asOf(1, t('0819381'))), true);
      assert.equal(isNewer(asOf(1, t('0819381')), asOf(1, t('0829381'))), false);
    });

    it('orders across second and minute boundaries', () => {
      assert.equal(isNewer(asOf(1, '2026-10-02T02:21:00.0000001+00:00'), asOf(1, '2026-10-02T02:20:59.9999999+00:00')), true);
    });

    it('handles non-UTC offsets', () => {
      assert.equal(isNewer(asOf(1, '2026-10-02T03:20:34.5000000+01:00'), asOf(1, '2026-10-02T02:20:34.4000000+00:00')), true);
      assert.equal(isNewer(asOf(1, '2026-10-02T03:20:34.0000000+01:00'), asOf(1, '2026-10-02T02:20:34.4000000+00:00')), false);
    });

    it('treats timestamps that differ only below one millisecond as equal (documented limitation)', () => {
      // Date.parse drops sub-millisecond digits, so a later push in the same millisecond with the
      // same sequence is not considered newer. Sequence is the real version; this only matters on ties.
      assert.equal(isNewer(asOf(1, t('0819999')), asOf(1, t('0819001'))), false);
    });
  });
});

describe('BookStore.apply', () => {
  it('stores a first book, converting prices to ticks', () => {
    const s = new BookStore();
    assert.equal(s.apply('ex', raw(0.45, 0.5), asOf(1)), true);
    assert.deepEqual(s.get('ex'), {
      bids: [{ priceT: 90, quantity: 100 }],
      asks: [{ priceT: 100, quantity: 80 }],
    });
  });

  it('get returns undefined for an unknown exchange', () => {
    assert.equal(new BookStore().get('nope'), undefined);
  });

  it('accepts a newer sequence and rejects an older or equal one', () => {
    const s = new BookStore();
    s.apply('ex', raw(0.45, 0.5), asOf(5));
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(4)), false);
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(5)), false);
    assert.equal(s.get('ex')!.bids[0]!.priceT, 90);
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(6)), true);
    assert.equal(s.get('ex')!.bids[0]!.priceT, 80);
  });

  it('rejects a versionless push over a versioned book', () => {
    const s = new BookStore();
    s.apply('ex', raw(0.45, 0.5), asOf(5));
    assert.equal(s.apply('ex', raw(0.1, 0.2), null), false);
    assert.equal(s.get('ex')!.bids[0]!.priceT, 90);
  });

  it('a versioned push replaces a versionless held book', () => {
    const s = new BookStore();
    s.apply('ex', raw(0.45, 0.5), null);
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(1)), true);
    assert.equal(s.get('ex')!.bids[0]!.priceT, 80);
  });

  it('force overrides ordering, including with an older version', () => {
    const s = new BookStore();
    s.apply('ex', raw(0.45, 0.5), asOf(10));
    assert.equal(s.apply('ex', raw(0.3, 0.35), asOf(2), null, true), true);
    assert.equal(s.get('ex')!.bids[0]!.priceT, 60);
    // and the forced version is now what later pushes are compared against
    assert.equal(s.apply('ex', raw(0.2, 0.25), asOf(3)), true);
    assert.equal(s.apply('ex', raw(0.1, 0.15), asOf(2)), false);
  });

  it('force with a null version works and lets any later versioned push in', () => {
    const s = new BookStore();
    s.apply('ex', raw(), asOf(10));
    s.apply('ex', raw(0.3, 0.35), null, null, true);
    assert.equal(s.apply('ex', raw(), asOf(1)), true);
  });

  it('keeps exchanges independent', () => {
    const s = new BookStore();
    s.apply('a', raw(0.45, 0.5), asOf(5));
    assert.equal(s.apply('b', raw(0.2, 0.25), asOf(1)), true);
    assert.equal(s.get('a')!.bids[0]!.priceT, 90);
    assert.equal(s.get('b')!.bids[0]!.priceT, 40);
  });

  it('handles empty books', () => {
    const s = new BookStore();
    s.apply('ex', { bids: [], asks: [] }, asOf(1));
    assert.deepEqual(s.get('ex'), { bids: [], asks: [] });
  });

  it('orders pushes with 7-digit engine timestamps on equal sequence', () => {
    const s = new BookStore();
    s.apply('ex', raw(0.45, 0.5), asOf(1, '2026-10-02T02:20:34.0819381+00:00'));
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(1, '2026-10-02T02:20:34.0809381+00:00')), false);
    assert.equal(s.apply('ex', raw(0.4, 0.55), asOf(1, '2026-10-02T02:20:34.0829381+00:00')), true);
  });
});

describe('BookStore expiry', () => {
  const at = '2026-10-02T02:20:34.0000000+00:00';
  const expiry = Date.parse(at);

  it('reports exchanges whose nextExpiryAt has passed', () => {
    const s = new BookStore();
    s.apply('a', raw(), asOf(1), at);
    s.apply('b', raw(), asOf(1), '2026-10-02T02:20:44+00:00');
    s.apply('c', raw(), asOf(1), null);
    assert.deepEqual(s.expired(expiry - 1), []);
    assert.deepEqual(s.expired(expiry), ['a']);
    assert.deepEqual(s.expired(expiry + 60_000).sort(), ['a', 'b']);
  });

  it('clearExpiry stops an exchange being reported', () => {
    const s = new BookStore();
    s.apply('a', raw(), asOf(1), at);
    s.clearExpiry('a');
    assert.deepEqual(s.expired(expiry + 1), []);
  });

  it('clearExpiry on an unknown exchange is a no-op', () => {
    assert.doesNotThrow(() => new BookStore().clearExpiry('nope'));
  });

  it('a newer book replaces the expiry', () => {
    const s = new BookStore();
    s.apply('a', raw(), asOf(1), at);
    s.apply('a', raw(), asOf(2), null);
    assert.deepEqual(s.expired(expiry + 1), []);
  });

  it('a rejected stale book does not change the expiry', () => {
    const s = new BookStore();
    s.apply('a', raw(), asOf(2), at);
    s.apply('a', raw(), asOf(1), null);
    assert.deepEqual(s.expired(expiry + 1), ['a']);
  });

  it('parses 7-digit fractional expiry timestamps', () => {
    const s = new BookStore();
    s.apply('a', raw(), asOf(1), '2026-10-02T02:20:34.0819381+00:00');
    assert.deepEqual(s.expired(Date.parse('2026-10-02T02:20:34.081Z')), ['a']);
    assert.deepEqual(s.expired(Date.parse('2026-10-02T02:20:34.080Z')), []);
  });
});
