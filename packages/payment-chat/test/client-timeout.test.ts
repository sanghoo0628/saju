import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserClient, PaymentChatClientError } from '../src/client.ts';
import { createCheckoutFlow } from '../src/checkout-flow.ts';
import { createHttpApi } from '../src/http.ts';
import { createMessageSendTracker } from '../src/message-send-tracker.ts';
import { fixture, alice } from './fixtures.ts';
import type { Schedule } from '../src/message-source.ts';

function clock() {
  const tasks: { run: () => void; cancelled: boolean; ms: number }[] = [];
  const schedule: Schedule = (run, ms) => {
    const task = { run, ms, cancelled: false }; tasks.push(task);
    return () => { task.cancelled = true; };
  };
  return { schedule, tasks, fire(index = 0) { const task = tasks[index]!; if (!task.cancelled) task.run(); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const never = <T>(): Promise<T> => new Promise(() => {});
const timedOut = (e: unknown) => e instanceof PaymentChatClientError && e.code === 'REQUEST_TIMEOUT' && e.status === 408;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('a stalled header response ends at the deadline even if fetch ignores abort', async () => {
  const timer = clock(); let signal: AbortSignal | undefined;
  const api = createBrowserClient(async (_url, init) => { signal = init?.signal ?? undefined; return never<Response>(); }, { schedule: timer.schedule });
  const pending = api.messages('room');
  const rejected = assert.rejects(pending, timedOut);
  assert.equal(timer.tasks[0]!.ms, 15000);
  timer.fire(); await rejected;
  assert.equal(signal?.aborted, true);
  assert.equal(timer.tasks[0]!.cancelled, true);
});

test('the deadline includes stalled JSON reading after successful headers', async () => {
  const timer = clock(); let started = false;
  const response = Response.json([]);
  response.json = () => { started = true; return never(); };
  const api = createBrowserClient(async () => response, { schedule: timer.schedule });
  const rejected = assert.rejects(api.conversations(), timedOut);
  await tick(); assert.equal(started, true);
  timer.fire(); await rejected;
});

test('caller cancellation wins while reading JSON and clears the deadline', async () => {
  const timer = clock(), parent = new AbortController(); let requestSignal: AbortSignal | undefined;
  const response = Response.json([]); response.json = () => never();
  const api = createBrowserClient(async (_url, init) => { requestSignal = init?.signal ?? undefined; return response; }, { schedule: timer.schedule });
  const reason = new DOMException('Leaving room', 'AbortError');
  const rejected = assert.rejects(api.messages('room', undefined, parent.signal), e => e === reason);
  await tick(); parent.abort(reason); await rejected;
  assert.equal(requestSignal?.reason, reason);
  assert.equal(timer.tasks[0]!.cancelled, true);
});

test('successful calls clear deadlines and detach the parent abort listener', async () => {
  const timer = clock(), parent = new AbortController(); let requestSignal: AbortSignal | undefined;
  const api = createBrowserClient(async (_url, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    requestSignal = init?.signal ?? undefined; return Response.json([]);
  }, { schedule: timer.schedule, timeoutMs: 200 });
  assert.deepEqual(await api.requests(undefined, parent.signal), []);
  assert.equal(timer.tasks[0]!.cancelled, true);
  parent.abort(); timer.fire();
  assert.equal(requestSignal?.aborted, false);
});

test('server, JSON and network errors retain their meaning and clear deadlines', async () => {
  for (const [reply, predicate] of [
    [async () => Response.json({ code: 'FORBIDDEN', message: 'No access' }, { status: 403 }), (e: unknown) => e instanceof PaymentChatClientError && e.status === 403 && e.code === 'FORBIDDEN'],
    [async () => new Response('Bad gateway', { status: 502 }), (e: unknown) => e instanceof PaymentChatClientError && e.code === 'INVALID_RESPONSE' && e.status === 502],
    [async () => { throw new TypeError('Disconnected'); }, (e: unknown) => e instanceof TypeError],
  ] as const) {
    const timer = clock(), api = createBrowserClient(reply, { schedule: timer.schedule });
    await assert.rejects(api.conversations(), predicate);
    assert.equal(timer.tasks[0]!.cancelled, true);
  }
});

test('concurrent requests have independent deadlines', async () => {
  const timer = clock(), second = deferred<Response>(); let calls = 0;
  const api = createBrowserClient(async () => ++calls === 1 ? never() : second.promise, { schedule: timer.schedule });
  const first = assert.rejects(api.requests(), timedOut), next = api.conversations();
  timer.fire(0); await first;
  assert.equal(timer.tasks[1]!.cancelled, false);
  second.resolve(Response.json([])); assert.deepEqual(await next, []);
  assert.equal(timer.tasks[1]!.cancelled, true);
});

test('invalid timeout settings fail before making any request', () => {
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 120001])
    assert.throws(() => createBrowserClient(fetch, { timeoutMs }), /Invalid API request timeout/);
});

for (const method of ['createOrder', 'requestChat', 'acceptChat', 'rejectChat', 'sendMessage'] as const) {
  test(`${method}: a timeout never automatically retries a write`, async () => {
    const timer = clock(); let writes = 0;
    const api = createBrowserClient(async (_url, init) => { assert.equal(init?.method, 'POST'); writes++; return never(); }, { schedule: timer.schedule });
    const pending = method === 'sendMessage' ? api.sendMessage('room', 'hello') : api[method]('id');
    const rejected = assert.rejects(pending, timedOut); timer.fire(); await rejected; await tick();
    assert.equal(writes, 1);
  });
}

test('a committed message with a timed-out response is recovered by history and explicit replay without duplication', async () => {
  const f = fixture(), room = await f.room(), origin = 'https://chat.example';
  const handler = createHttpApi({ service: f.service, appOrigin: origin, getCurrentUserId: async () => alice.userId });
  const timer = clock(), committed = deferred<void>(), late = deferred<Response>();
  let hold = true, writes = 0;
  const api = createBrowserClient(async (path, init) => {
    const response = await handler(new Request(new URL(String(path), origin), {
      ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
    }));
    if (init?.method === 'POST') {
      writes++;
      if (hold) { hold = false; committed.resolve(); return late.promise; }
    }
    return response;
  }, { schedule: timer.schedule });
  const tracker = createMessageSendTracker(alice.userId, room, () => '40000000-0000-4000-8000-000000000001');
  const attempt = tracker.prepare('hello');
  const rejected = assert.rejects(api.sendMessage(room, attempt.body, undefined, attempt.clientMessageId), timedOut);
  await committed.promise; timer.fire(); await rejected;
  assert.equal(writes, 1); assert.equal(f.state.messages.length, 1);
  const again = tracker.prepare('hello');
  const message = await api.sendMessage(room, again.body, undefined, again.clientMessageId);
  assert.ok(tracker.confirm(message));
  late.resolve(Response.json(message)); await tick();
  assert.equal(f.state.messages.length, 1); assert.equal(writes, 2);
  assert.deepEqual(await api.messages(room), [message]);
});

test('a stalled checkout unlocks with an error and only an explicit retry creates another call', async () => {
  const timer = clock(); let writes = 0;
  const api = createBrowserClient(async () => {
    if (++writes === 1) return never();
    return Response.json({ kind: 'payment_required', orderId: 'same-order', amountKrw: 500, checkoutUrl: 'https://checkout.example' });
  }, { schedule: timer.schedule });
  const flow = createCheckoutFlow({ client: api });
  const first = flow.start('match'); await tick(); timer.fire(); await first;
  assert.equal(flow.snapshot().kind, 'error'); assert.equal(writes, 1);
  await flow.start('match');
  assert.equal(flow.snapshot().kind, 'payment_required'); assert.equal(writes, 2);
  flow.dispose();
});
