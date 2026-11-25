/** Browser client -> HTTP adapter -> service -> disposable native PostgreSQL.
 * Transport failures and Realtime notifications are simulated; no Supabase, billing or mail calls.
 */
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { startNativePostgres } from './native-postgres';
import { seedUsers, uid } from '../db/harness';
import { createPostgresRepository } from '../../src/server/postgres-repository';
import { createService } from '../../packages/payment-chat/src/service';
import { createHttpApi } from '../../packages/payment-chat/src/http';
import { createBrowserClient } from '../../packages/payment-chat/src/client';
import { createMessageSession, type MessageSession } from '../../packages/payment-chat/src/message-session';
import { createMessageSendTracker } from '../../packages/payment-chat/src/message-send-tracker';
import { clock, source, deferred } from '../../packages/payment-chat/test/realtime-fixtures';
import type { ConversationResponse } from '../../contracts/payment-chat';

const buyer = uid(1), peer = uid(2), origin = 'https://chat.fixture.invalid';
let db: Awaited<ReturnType<typeof startNativePostgres>>;
let handle: ReturnType<typeof createHttpApi>;
let room: ConversationResponse;
let expired: Set<string>;
let sessions: MessageSession[];

function browser(userId: string, options: {
  clock?: ReturnType<typeof clock>;
  afterCommit?: () => void;
} = {}) {
  let dropNextSend = !!options.afterCommit;
  return createBrowserClient(async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', origin);
    // The identity header is understood only by this fixture's in-process HTTP adapter.
    headers.set('X-Fixture-User', userId);
    const response = await handle(new Request(new URL(String(input), origin), { ...init, headers }));
    if (dropNextSend && init?.method === 'POST' && String(input).endsWith('/messages') && response.ok) {
      dropNextSend = false;
      options.afterCommit?.();
      // Deliberately ignore AbortSignal, as a stalled transport may do. Client timeout must still settle.
      return new Promise<Response>(() => {});
    }
    return response;
  }, options.clock ? { schedule: options.clock.schedule } : {});
}

function session(api: ReturnType<typeof browser>, stream?: ReturnType<typeof source>) {
  const timer = clock();
  const value = createMessageSession({ userId: buyer, conversation: room, client: api,
    source: stream?.source, schedule: timer.schedule });
  sessions.push(value);
  value.start();
  return { value, timer };
}

const storedCount = async () => (await db.pool.query('select count(*)::integer n from public.messages')).rows[0].n;

beforeAll(async () => { db = await startNativePostgres(); }, 60000);
afterAll(async () => { if (db) await db.close(); }, 30000);
afterEach(() => { for (const value of sessions ?? []) value.dispose(); });
beforeEach(async () => {
  sessions = [];
  expired = new Set();
  await db.pool.query(`truncate public.messages,public.conversations,public.chat_requests,public.payments,
    public.orders,public.match_results,auth.users cascade`);
  await seedUsers(db.pool, [{ id: buyer, score: 1200 }, { id: peer, score: -1199 }]);
  const service = createService({ repository: createPostgresRepository(db.pool, { retryDelayMs: 0 }),
    gateway: { productId: 'local-fixture', checkoutUrl: reference => `https://checkout.fixture.invalid/?ref=${reference}`,
      verifyCompleted: async () => { throw new Error('No payment provider in this test'); } } });
  handle = createHttpApi({ service, appOrigin: origin,
    getCurrentUserId: async request => {
      const user = request.headers.get('X-Fixture-User');
      return user && [buyer, peer].includes(user) && !expired.has(user) ? user : null;
    } });
  const matchId = (await db.pool.query('select id from public.get_or_create_match_results($1)', [buyer])).rows[0].id;
  const purchasing = browser(buyer), receiving = browser(peer);
  const order = await purchasing.createOrder(matchId);
  if (order.kind !== 'payment_required') throw new Error('Missing fixture order');
  // Local fixture entitlement only, analogous to B's manually prepared QA order. Never a real payment.
  await db.pool.query("update public.orders set status='fulfilled' where id=$1", [order.orderId]);
  const invitation = await purchasing.requestChat(order.orderId);
  const accepted = await receiving.acceptChat(invitation.id);
  const found = (await purchasing.conversations()).find(value => value.id === accepted.conversationId);
  if (!found) throw new Error('Missing fixture conversation');
  room = found;
});

it('a committed send with a lost response is retried with the same UUID and stored/displayed once', async () => {
  const timer = clock(), committed = deferred<void>();
  const api = browser(buyer, { clock: timer, afterCommit: () => committed.resolve() });
  const tracker = createMessageSendTracker(buyer, room.id, () => uid(9001));
  const attempt = tracker.prepare('response lost after commit');
  const sending = api.sendMessage(room.id, attempt.body, undefined, attempt.clientMessageId)
    .then(message => ({ message }), error => ({ error }));
  await committed.promise;
  expect(await storedCount()).toBe(1);
  timer.tick();
  expect(await sending).toMatchObject({ error: { code: 'REQUEST_TIMEOUT', status: 408 } });
  expect(tracker.pending()).toEqual(attempt);
  const retry = tracker.prepare(attempt.body);
  expect(retry.clientMessageId).toBe(attempt.clientMessageId);
  const response = await api.sendMessage(room.id, retry.body, undefined, retry.clientMessageId);
  expect(tracker.confirm(response)).toEqual(attempt);
  expect(tracker.pending()).toBeUndefined();
  const history = session(api);
  await history.value.refresh();
  history.value.receive(response);
  expect(history.value.snapshot().messages.map(message => message.id)).toEqual([attempt.clientMessageId]);
  expect(await storedCount()).toBe(1);
  tracker.dispose();
});

it('HTTP history can confirm a timed-out send without another POST', async () => {
  const timer = clock(), committed = deferred<void>();
  const api = browser(buyer, { clock: timer, afterCommit: () => committed.resolve() });
  const tracker = createMessageSendTracker(buyer, room.id, () => uid(9002));
  const history = session(api);
  const unsubscribe = history.value.subscribe(snapshot => {
    for (const message of snapshot.messages) tracker.confirm(message);
  });
  await history.value.refresh();
  const attempt = tracker.prepare('recover through authenticated history');
  const sending = api.sendMessage(room.id, attempt.body, undefined, attempt.clientMessageId).catch(error => error);
  await committed.promise;
  timer.tick();
  expect(await sending).toMatchObject({ code: 'REQUEST_TIMEOUT' });
  expect(tracker.pending()).toEqual(attempt);
  await history.value.refresh();
  expect(tracker.pending()).toBeUndefined();
  expect(history.value.snapshot().messages.map(message => message.id)).toEqual([attempt.clientMessageId]);
  expect(await storedCount()).toBe(1);
  unsubscribe(); tracker.dispose();
});

it('reconnection fills missed messages once, then a bidirectional block clears history and prevents sends', async () => {
  const api = browser(buyer), partner = browser(peer), stream = source();
  const history = session(api, stream);
  await history.value.refresh();
  stream.callbacks.onStatus('reconnecting');
  const first = await partner.sendMessage(room.id, 'missed while offline', undefined, uid(9003));
  const second = await partner.sendMessage(room.id, 'also missed', undefined, uid(9004));
  stream.callbacks.onStatus('live');
  await history.value.refresh();
  stream.callbacks.onMessage(first);
  stream.callbacks.onMessage(second);
  expect(history.value.snapshot().messages.map(message => message.id)).toEqual([first.id, second.id]);
  await db.pool.query('insert into public.blocks(blocker_id,blocked_id) values($1,$2)', [peer, buyer]);
  await history.value.refresh();
  expect(history.value.snapshot().messages).toEqual([]);
  expect(history.value.snapshot().accessError).not.toBe('');
  expect(stream.stops).toBe(1);
  expect(history.timer.jobs.filter(job => job.active)).toHaveLength(0);
  stream.callbacks.onMessage(second);
  expect(history.value.snapshot().messages).toEqual([]);
  await expect(api.sendMessage(room.id, 'must not be saved', undefined, uid(9005))).rejects.toMatchObject({ code: 'BLOCKED', status: 403 });
  await expect(partner.messages(room.id)).rejects.toMatchObject({ code: 'BLOCKED', status: 403 });
  expect(await storedCount()).toBe(2);
});

it('an expired HTTP identity clears visible messages and ignores subsequent Realtime notifications', async () => {
  const api = browser(buyer), stream = source();
  const saved = await browser(peer).sendMessage(room.id, 'before expiry', undefined, uid(9006));
  const history = session(api, stream);
  await history.value.refresh();
  expect(history.value.snapshot().messages).toHaveLength(1);
  expired.add(buyer);
  await history.value.refresh();
  expect(history.value.snapshot().messages).toEqual([]);
  expect(history.value.snapshot().connection).toBe('auth_required');
  expect(stream.stops).toBe(1);
  stream.callbacks.onMessage(saved);
  expect(history.value.snapshot().messages).toEqual([]);
  await expect(api.sendMessage(room.id, 'expired sender', undefined, uid(9007))).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  expect(await storedCount()).toBe(1);
});
