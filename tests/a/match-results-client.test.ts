import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMatchResults } from '../../src/lib/match-results-client';
import { PaymentChatClientError } from '../../packages/payment-chat/src/client';
import type { Schedule } from '../../packages/payment-chat/src/message-source';

function clock() {
  let fire = () => {};
  let cancelled = false;
  const schedule: Schedule = (run, delay) => {
    assert.equal(delay, 15000);
    fire = run;
    return () => { cancelled = true; };
  };
  return { schedule, fire: () => fire(), cancelled: () => cancelled };
}
const never = <T>(): Promise<T> => new Promise(() => {});
const timeout = (error: unknown) => error instanceof PaymentChatClientError && error.code === 'REQUEST_TIMEOUT';

test('free recommendations use only an authenticated, uncached GET and clear the timer', async () => {
  const timer = clock();
  const result = { status: 'no_candidates', results: [] };
  assert.deepEqual(await loadMatchResults(undefined, async (path, init) => {
    assert.equal(path, '/api/match-results');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.body, undefined);
    return Response.json(result);
  }, timer), result);
  assert.equal(timer.cancelled(), true);
});

test('stalled recommendation headers time out without automatic retries', async () => {
  const timer = clock();
  let calls = 0;
  const rejected = assert.rejects(loadMatchResults(undefined, async () => {
    calls++;
    return never<Response>();
  }, timer), timeout);
  timer.fire();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(timer.cancelled(), true);
});

test('recommendation timeout includes a stalled response body', async () => {
  const timer = clock();
  const response = Response.json({});
  response.json = () => never();
  const rejected = assert.rejects(loadMatchResults(undefined, async () => response, timer), timeout);
  await new Promise<void>(resolve => setImmediate(resolve));
  timer.fire();
  await rejected;
});

test('leaving recommendations cancels the pending request and clears its deadline', async () => {
  const timer = clock(), parent = new AbortController();
  let inner: AbortSignal | null | undefined;
  const rejected = assert.rejects(loadMatchResults(parent.signal, async (_path, init) => {
    inner = init?.signal;
    return never<Response>();
  }, timer), { name: 'AbortError' });
  parent.abort();
  await rejected;
  assert.equal(inner?.aborted, true);
  assert.equal(timer.cancelled(), true);
});

test('B nested errors retain their HTTP status and user-facing message', async () => {
  await assert.rejects(loadMatchResults(undefined, async () => Response.json({ error: {
    code: 'UNAUTHENTICATED', message: '학교 이메일로 로그인해주세요.',
  } }, { status: 401 })), (error: unknown) => error instanceof PaymentChatClientError
    && error.status === 401 && error.code === 'UNAUTHENTICATED' && error.message === '학교 이메일로 로그인해주세요.');
});

test('HTML failures are recoverable and a later explicit reload can succeed', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => ++calls === 1
    ? new Response('Bad gateway', { status: 502 })
    : Response.json({ status: 'profile_required', results: [] });
  await assert.rejects(loadMatchResults(undefined, fetcher), (error: unknown) => error instanceof PaymentChatClientError
    && error.code === 'INVALID_RESPONSE' && error.status === 502);
  assert.deepEqual(await loadMatchResults(undefined, fetcher), { status: 'profile_required', results: [] });
  assert.equal(calls, 2);
});
