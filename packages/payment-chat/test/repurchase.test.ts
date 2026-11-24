import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, alice, bob, denied } from './fixtures.ts';

test('a pending request is rebound to the new fulfilled order after refund and repurchase', async () => {
  const f = fixture();
  const old = await f.paid();
  const request = await f.service.requestChat(alice, old);
  f.state.orders.find(order => order.id === old)!.status = 'refunded';
  const replacement = await f.paid();
  const rebound = await f.service.requestChat(alice, replacement);
  assert.equal(rebound.id, request.id);
  assert.equal(rebound.orderId, replacement);
  const room = await f.service.acceptChat(bob, request.id);
  assert.ok(room.conversationId);
  assert.equal(f.state.requests.length, 1);
});

test('a rejected pair cannot be reported as chat_available or charged again', async () => {
  const f = fixture();
  const paid = await f.paid();
  const request = await f.service.requestChat(alice, paid);
  await f.service.rejectChat(bob, request.id);
  await assert.rejects(f.service.createOrder(alice, 'a-b'), denied('INVALID_REQUEST'));
  f.state.orders.find(order => order.id === paid)!.status = 'refunded';
  await assert.rejects(f.service.createOrder(alice, 'a-b'), denied('INVALID_REQUEST'));
  assert.equal(f.state.orders.length, 1);
  assert.equal(f.state.requests[0]!.status, 'rejected');
});

test('an unpaid replacement cannot rebind or authorize the refunded request', async () => {
  const f = fixture();
  const old = await f.paid();
  const request = await f.service.requestChat(alice, old);
  f.state.orders.find(order => order.id === old)!.status = 'refunded';
  const pending = await f.service.createOrder(alice, 'a-b');
  if (pending.kind !== 'payment_required') throw new Error('pending order missing');
  await assert.rejects(f.service.requestChat(alice, pending.orderId), denied('FORBIDDEN'));
  await assert.rejects(f.service.acceptChat(bob, request.id), denied('FORBIDDEN'));
  assert.equal(f.state.requests[0]!.orderId, old);
});
