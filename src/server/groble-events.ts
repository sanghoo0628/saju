import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ConfigurationError } from '@/lib/env/schema';
import { ServiceError } from '../../packages/payment-chat/src/service';

const REFERENCE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
const SIGNATURE = /^[a-fA-F0-9]{64}$/;
const invalid = (): never => { throw new ServiceError('INVALID_WEBHOOK', '결제 웹훅을 확인할 수 없습니다.'); };
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const timestampSchema = z.iso.datetime({ offset: true });
const instant = (value: unknown): value is string => timestampSchema.safeParse(value).success;
interface EventBase {
  eventId: string;
  idempotencyKey: string;
  occurredAt: string;
  transactionId: string;
  productId: string;
  amount: 500;
  currency: 'KRW';
}
export type GroblePaymentEvent = EventBase & (
  | { type: 'payment.completed'; reference: string }
  | { type: 'payment.cancel_requested'; requestedAt: string }
  | { type: 'payment.refunded'; refundAmount: number; partialRefund: boolean;
      refundedAt: string; refundDeduplicationKey: string }
);

/** Verification only: does not acknowledge, persist events or change payment/chat rights. */
export function createGrobleEventVerifier(options: {
  productId: string;
  secret: string;
  previousSecret?: string;
  previousSecretExpiresAt?: number;
  now?: () => number;
}) {
  if (!identifier(options.productId)) throw new ConfigurationError(['GROBLE_PRODUCT_ID']);
  if (!options.secret || !options.secret.trim()) throw new ConfigurationError(['GROBLE_WEBHOOK_SECRET']);
  const now = options.now ?? Date.now;
  if (options.previousSecret && (!options.previousSecret.trim() || !Number.isFinite(options.previousSecretExpiresAt)
    || options.previousSecretExpiresAt! > now() + 24 * 60 * 60 * 1000))
    throw new ConfigurationError(['GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT']);
  return async function verifyEvent(raw: Uint8Array, headers: Headers): Promise<GroblePaymentEvent> {
    if (raw.byteLength === 0 || raw.byteLength > 256 * 1024) invalid();
    const timestamp = headers.get('x-groble-timestamp');
    const signature = headers.get('x-groble-signature');
    const previous = headers.get('x-groble-signature-previous');
    const eventKey = headers.get('x-groble-idempotency-key');
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || !SIGNATURE.test(signature)
      || !identifier(eventKey)) invalid();
    if (Math.abs(now() / 1000 - Number(timestamp)) > 300) invalid();
    const message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), Buffer.from(raw)]);
    const signatures = [signature, previous].filter((value): value is string => !!value && SIGNATURE.test(value));
    const previousActive = options.previousSecretExpiresAt !== undefined && now() <= options.previousSecretExpiresAt;
    const secrets = [options.secret, previousActive ? options.previousSecret : undefined].filter((value): value is string => !!value);
    let verified = false;
    for (const secret of secrets) {
      const expected = createHmac('sha256', secret).update(message).digest();
      for (const candidate of signatures) if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) verified = true;
    }
    if (!verified) invalid();
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return invalid(); }
    if (!identifier(payload?.id) || payload.version !== '2026-04-30' || !instant(payload.occurredAt)) invalid();
    const object = payload?.data?.object;
    if (!object || !identifier(object.merchantUid) || object.content?.id !== options.productId
      || object.content?.paymentType !== 'ONE_TIME' || object.pricing?.currency !== 'KRW'
      || object.pricing?.finalAmount !== 500) invalid();
    const base: EventBase = { eventId: payload.id, idempotencyKey: eventKey as string, occurredAt: payload.occurredAt,
      transactionId: object.merchantUid, productId: options.productId, amount: 500, currency: 'KRW' };
    switch (payload.type) {
      case 'payment.completed':
        if (typeof object.sellerReference !== 'string' || !REFERENCE.test(object.sellerReference)) invalid();
        return { ...base, type: payload.type, reference: object.sellerReference };
      case 'payment.cancel_requested':
        if (!instant(object.cancelRequest?.requestedAt)) invalid();
        return { ...base, type: payload.type, requestedAt: object.cancelRequest.requestedAt };
      case 'payment.refunded': {
        const refund = object.refund;
        if (!refund || refund.currency !== 'KRW' || typeof refund.partialRefund !== 'boolean'
          || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > 500
          || (!refund.partialRefund && refund.amount !== 500) || !instant(refund.refundedAt)) invalid();
        const refundedAt = new Date(refund.refundedAt).toISOString();
        return { ...base, type: payload.type, refundAmount: refund.amount, partialRefund: refund.partialRefund,
          refundedAt, refundDeduplicationKey: JSON.stringify([object.merchantUid, refundedAt]) };
      }
      default: return invalid();
    }
  };
}
