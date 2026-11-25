import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createGrobleEventVerifier } from '../../src/server/groble-events';
import { createGrobleGateway } from '../../src/server/groble-gateway';
import { ServiceError } from '../../packages/payment-chat/src/service';

const now = 1795510000000;
const secret = 'fixture-only-secret';
const config = { productId: 'product', secret, now: () => now };
const verify = createGrobleEventVerifier(config);
function event(type = 'payment.refunded') {
  return { id: 'evt-refund', type, version: '2026-04-30', occurredAt: '2026-11-25T12:00:00+09:00', data: { object: {
    merchantUid: 'merchant', content: { id: 'product', paymentType: 'ONE_TIME' }, pricing: { finalAmount: 500, currency: 'KRW' },
    refund: { amount: 500, currency: 'KRW', partialRefund: false, refundedAt: '2026-11-25T12:00:00+09:00' },
    cancelRequest: { requestedAt: '2026-11-25T11:00:00+09:00', detailReason: 'private reason' },
    buyer: { email: 'private@example.invalid', phoneNumber: 'private-number' },
  } } };
}
function signed(payload: unknown, key = 'delivery-1') {
  const raw = Buffer.from(JSON.stringify(payload));
  const timestamp = String(now / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return { raw, headers: new Headers({ 'X-Groble-Signature': signature, 'X-Groble-Timestamp': timestamp, 'X-Groble-Idempotency-Key': key }) };
}
const run = (payload: unknown, key?: string) => { const { raw, headers } = signed(payload, key); return verify(raw, headers); };
const invalid = (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_WEBHOOK';

test('refund without sellerReference maps to original transaction and excludes buyer PII', async () => {
  const result = await run(event());
  assert.deepEqual(result, { eventId: 'evt-refund', idempotencyKey: 'delivery-1', type: 'payment.refunded',
    occurredAt: '2026-11-25T12:00:00+09:00', transactionId: 'merchant', productId: 'product', amount: 500, currency: 'KRW',
    refundAmount: 500, partialRefund: false, refundedAt: '2026-11-25T03:00:00.000Z',
    refundDeduplicationKey: '["merchant","2026-11-25T03:00:00.000Z"]' });
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('cancellation request is distinct from completed refund and contains no refund amount', async () => {
  const result = await run(event('payment.cancel_requested'));
  assert.equal(result.type, 'payment.cancel_requested');
  assert.equal('refundAmount' in result, false);
  assert.equal('reference' in result, false);
});
test('partial refund reports this refund amount, never the original price', async () => {
  const value = event(); value.data.object.refund.amount = 200; value.data.object.refund.partialRefund = true;
  const result = await run(value);
  assert.equal(result.type === 'payment.refunded' && result.refundAmount, 200);
  assert.equal(result.amount, 500);
});
test('same refund has a stable business key across delivery IDs and timestamp offsets', async () => {
  const first = await run(event()); const value = event(); value.id = 'evt-redelivery';
  value.data.object.refund.refundedAt = '2026-11-25T03:00:00Z';
  const replay = await run(value, 'delivery-2');
  assert.notEqual(first.idempotencyKey, replay.idempotencyKey);
  assert.equal(first.type === 'payment.refunded' && first.refundDeduplicationKey,
    replay.type === 'payment.refunded' && replay.refundDeduplicationKey);
});
test('different partial refunds retain separate business keys', async () => {
  const value = event(); value.data.object.refund.partialRefund = true; value.data.object.refund.amount = 100;
  const first = await run(value); value.data.object.refund.refundedAt = '2026-11-25T12:01:00+09:00';
  const next = await run(value);
  assert.notEqual(first.type === 'payment.refunded' && first.refundDeduplicationKey,
    next.type === 'payment.refunded' && next.refundDeduplicationKey);
});
for (const amount of [0, -1, 501, 1.5, 200]) test(`invalid full refund amount ${amount} is rejected`, async () => {
  const value = event(); value.data.object.refund.amount = amount; await assert.rejects(run(value), invalid);
});
for (const field of ['currency', 'partialRefund', 'refundedAt']) test(`refund requires valid ${field}`, async () => {
  const value = event(); const refund = value.data.object.refund as Record<string, unknown>;
  refund[field] = field === 'currency' ? 'USD' : field === 'partialRefund' ? 'false' : '2026-11-25';
  await assert.rejects(run(value), invalid);
});
for (const type of ['subscription_payment.refunded', 'unknown', 'payment.completed']) test(`incompatible event ${type} cannot be mistaken for refund`, async () => {
  await assert.rejects(run(event(type)), invalid);
});
test('completion-only gateway continues rejecting authenticated cancellation and refund', async () => {
  const gateway = createGrobleGateway({ ...config, paymentUrl: 'https://groble.im/payment/fixture' });
  for (const type of ['payment.cancel_requested', 'payment.refunded']) {
    const { raw, headers } = signed(event(type)); await assert.rejects(gateway.verifyCompleted(raw, headers), invalid);
  }
});
test('untrusted signature cannot introduce refund data', async () => {
  const { raw, headers } = signed(event()); headers.set('X-Groble-Signature', '0'.repeat(64));
  await assert.rejects(verify(raw, headers), invalid);
});
test('cancellation must carry a timestamp with timezone', async () => {
  const value = event('payment.cancel_requested'); value.data.object.cancelRequest.requestedAt = '2026-11-25T11:00:00';
  await assert.rejects(run(value), invalid);
});
test('delivery identifier and envelope identifiers cannot be empty', async () => {
  await assert.rejects(run(event(), '   '), invalid);
  const value = event(); value.id = ''; await assert.rejects(run(value), invalid);
});
test('refund validator does not depend on event delivery order', async () => {
  const refund = await run(event()); const value = event('payment.completed');
  const payload = { ...value, occurredAt: '2026-11-25T10:00:00+09:00', data: { object: { ...value.data.object, sellerReference: 'opaque-ref' } } };
  const completion = await run(payload);
  assert.equal(refund.type, 'payment.refunded'); assert.equal(completion.type, 'payment.completed');
  // Persistence/state reconciliation deliberately belongs to a later transaction handler.
});

for (const date of ['2026-02-30T12:00:00Z', '2026-11-25T25:00:00Z', '2026-11-25T12:00:00', 'not-a-date']) {
  test('invalid refund instant is rejected: ' + date, async () => {
    const value = event(); value.data.object.refund.refundedAt = date;
    await assert.rejects(run(value), invalid);
  });
}
