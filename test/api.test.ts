import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// config reads required env at import; a dummy key keeps the real .env out of the test.
process.env.SIG_API_KEY = 'test-key';
const { Api, DeadlineError } = await import('../src/api.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(...responses: (() => Response | Promise<Response>)[]) {
  let calls = 0;
  globalThis.fetch = (async () => responses[Math.min(calls++, responses.length - 1)]!()) as typeof fetch;
  return () => calls;
}

const inFlight = () =>
  new Response(JSON.stringify({ error: { code: 'REQUEST_IN_FLIGHT', message: 'still executing' } }), { status: 409 });

describe('Api write deadlines', () => {
  it('gives up instead of sleeping out a 90s in-flight lease past the deadline', async () => {
    const calls = respondWith(inFlight);
    const started = Date.now();
    await assert.rejects(
      new Api().placeBatch([], Date.now() + 30_000),
      (err: unknown) => err instanceof DeadlineError,
    );
    assert.equal(calls(), 1);
    assert.ok(Date.now() - started < 1_000, 'returned without waiting');
  });

  it('gives up on a network error when the backoff would cross the deadline', async () => {
    const calls = respondWith(() => Promise.reject(new TypeError('fetch failed')));
    await assert.rejects(
      new Api().placeBatch([], Date.now() + 50),
      (err: unknown) => err instanceof DeadlineError,
    );
    assert.ok(calls() <= 2);
  });

  it('does not start a request when the deadline has already passed', async () => {
    const calls = respondWith(() => new Response('{"results":[]}', { status: 200 }));
    await assert.rejects(new Api().placeBatch([], Date.now() - 1), (err: unknown) => err instanceof DeadlineError);
    assert.equal(calls(), 0);
  });

  it('still retries quick transient failures inside the deadline', async () => {
    respondWith(
      () => new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }), { status: 503 }),
      () => new Response('{"results":[{"index":0,"ok":true,"status":201,"data":{"orderId":1}}]}', { status: 207 }),
    );
    const r = await new Api().placeBatch([], Date.now() + 30_000);
    assert.equal(r.results[0]!.ok, true);
  });
});
