import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationAction } from '../src/recommendation-action.ts';
import { createInboxSession, initialInboxSelection, reconcileInboxSelection, type InboxSnapshot } from '../src/inbox-session.ts';
import { createBrowserClient } from '../src/client.ts';
import { createHttpApi } from '../src/http.ts';
import { fixture, alice, bob } from './fixtures.ts';
import { clock } from './realtime-fixtures.ts';
import type { ChatRequestResponse } from '../../../contracts/payment-chat.ts';

const request: ChatRequestResponse = { id: 'request-1', from: 'alice', to: 'bob', orderId: 'order-1', status: 'pending', createdAt: '2026-11-26T00:00:00Z' };
const inbox = (extra: Partial<InboxSnapshot> = {}): InboxSnapshot => ({ userId: 'alice', rooms: [], requests: [], loading: false,
  refreshing: false, error: '', accessDenied: false, requestsComplete: true, roomsComplete: true, ...extra });

test('only a completed initial inbox check with no known relationship offers checkout', () => {
  assert.equal(recommendationAction('alice', 'bob', inbox()).kind, 'checkout');
  for (const state of [inbox({ loading: true }), inbox({ error: 'offline' }), inbox({ accessDenied: true }), inbox({ userId: 'bob' })])
    assert.equal(recommendationAction('alice', 'bob', state).kind, 'disabled');
  for (const state of [inbox({ requestsComplete: false }), inbox({ roomsComplete: false })])
    assert.deepEqual(recommendationAction('alice', 'bob', state), { kind: 'navigate', label: '대화 목록에서 상태 확인', href: '/requests' });
});

test('an existing room takes precedence over requests and a transient refresh error', () => {
  const result = recommendationAction('alice', 'bob', inbox({ requests: [request], error: 'offline',
    rooms: [{ id: 'room-1', members: ['alice', 'bob'], createdAt: request.createdAt }] }));
  assert.deepEqual(result, { kind: 'navigate', label: '대화 이어가기 · 무료', href: '/chat?room=room-1' });
});

test('both sent and received pending requests navigate to their detail instead of checkout', () => {
  assert.deepEqual(recommendationAction('alice', 'bob', inbox({ requests: [request] })),
    { kind: 'navigate', label: '수락 대기 중 · 요청 확인', href: '/requests?request=request-1' });
  assert.deepEqual(recommendationAction('alice', 'bob', inbox({ requests: [{ ...request, id: 'incoming', from: 'bob', to: 'alice' }, request] })),
    { kind: 'navigate', label: '받은 대화 요청 확인 · 무료', href: '/requests?request=incoming' });
});

test('completed requests go to their outcome without assuming a refund or another charge', () => {
  for (const status of ['accepted', 'rejected'] as const) {
    const action = recommendationAction('alice', 'bob', inbox({ requests: [{ ...request, status }] }));
    assert.equal(action.kind, 'navigate');
    assert.ok(!action.label.includes('500') && !action.label.includes('환불'));
  }
});

test('other people relationships and self profiles cannot create a false free entitlement', () => {
  const state = inbox({ requests: [{ ...request, from: 'eve' }],
    rooms: [{ id: 'foreign', members: ['eve', 'bob'], createdAt: request.createdAt }] });
  assert.equal(recommendationAction('alice', 'bob', state).kind, 'checkout');
  assert.equal(recommendationAction('alice', 'alice', state).kind, 'disabled');
});

test('a URL selection is applied only after the matching authenticated list actually contains it', () => {
  const selection = { kind: 'request' as const, id: request.id };
  assert.deepEqual(initialInboxSelection(selection, 'alice', inbox({ requests: [request] })), selection);
  for (const state of [inbox(), inbox({ requestsComplete: false }), inbox({ loading: true, requests: [request] }),
    inbox({ error: 'offline', requests: [request] }), inbox({ accessDenied: true, requests: [request] }),
    inbox({ userId: 'bob', requests: [request] }), inbox({ requests: [{ ...request, from: 'eve', to: 'bob' }] })])
    assert.equal(initialInboxSelection(selection, 'alice', state), null);
  const room = { id: 'room-1', members: ['alice', 'bob'] as [string, string], createdAt: request.createdAt };
  assert.deepEqual(initialInboxSelection({ kind: 'room', id: room.id }, 'alice', inbox({ rooms: [room] })), { kind: 'room', id: room.id });
  assert.equal(initialInboxSelection({ kind: 'room', id: 'unknown' }, 'alice', inbox({ rooms: [room] })), null);
});

test('real HTTP inbox request and acceptance lead from recommendation to the same room with one order', async () => {
  const f = fixture(), origin = 'https://app.fixture.invalid';
  const handle = createHttpApi({ service: f.service, appOrigin: origin, getCurrentUserId: async req => req.headers.get('X-Fixture-User') });
  const browser = (userId: string) => createBrowserClient(async (input, init) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('X-Fixture-User', userId);
    return handle(new Request(new URL(String(input), origin), { ...init, headers }));
  });
  const order = await f.paid();
  const invitation = await browser(alice.userId).requestChat(order);
  const session = createInboxSession({ userId: alice.userId, client: browser(alice.userId), schedule: clock().schedule });
  try {
    session.start(); await session.refresh();
    const action = recommendationAction('alice', 'bob', session.snapshot());
    assert.equal(action.kind, 'navigate');
    if (action.kind !== 'navigate') throw new Error('Expected existing request');
    const id = new URL(action.href, origin).searchParams.get('request')!;
    const selected = initialInboxSelection({ kind: 'request', id }, 'alice', session.snapshot());
    assert.deepEqual(selected, { kind: 'request', id: invitation.id });
    const accepted = await browser(bob.userId).acceptChat(invitation.id);
    await session.refresh();
    assert.deepEqual(reconcileInboxSelection(selected, 'alice', session.snapshot()), { kind: 'room', id: accepted.conversationId });
    const next = recommendationAction('alice', 'bob', session.snapshot());
    assert.equal(next.kind, 'navigate');
    assert.equal(next.kind === 'navigate' && next.href, `/chat?room=${accepted.conversationId}`);
    assert.equal(f.state.orders.length, 1); assert.equal(f.state.requests.length, 1);
  } finally { session.dispose(); }
});
