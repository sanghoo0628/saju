import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from '@/lib/env/schema';
import { ServiceError } from '../../packages/payment-chat/src/service';
import type { CompletedPayment, PaymentGateway } from '../../packages/payment-chat/src/ports';

const REFERENCE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
const SIGNATURE = /^[a-fA-F0-9]{64}$/;
const invalid = (): never => { throw new ServiceError('INVALID_WEBHOOK', '결제 웹훅을 확인할 수 없습니다.'); };

/** Official one-time completion adapter. Kept disconnected until seller setup and refund handling are verified. */
export function createGrobleGateway(options: {
  paymentUrl: string;
  productId: string;
  secret: string;
  previousSecret?: string;
  /** Absolute milliseconds since epoch; an old key must never remain valid indefinitely. */
  previousSecretExpiresAt?: number;
  now?: () => number;
}): PaymentGateway {
  let base: URL;
  try {
    base = new URL(options.paymentUrl);
    if (base.protocol !== 'https:' || !['groble.im', 'www.groble.im'].includes(base.hostname)
      || base.username || base.password || base.port || base.hash || !/^\/payment\/[^/]+\/?$/.test(base.pathname)) throw new Error();
  } catch { throw new ConfigurationError(['GROBLE_PAYMENT_URL']); }
  if (!options.productId || options.productId !== options.productId.trim()) throw new ConfigurationError(['GROBLE_PRODUCT_ID']);
  if (!options.secret || !options.secret.trim()) throw new ConfigurationError(['GROBLE_WEBHOOK_SECRET']);
  const now = options.now ?? Date.now;
  if (options.previousSecret && (!Number.isFinite(options.previousSecretExpiresAt)
    || options.previousSecretExpiresAt! > now() + 24 * 60 * 60 * 1000))
    throw new ConfigurationError(['GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT']);
  return {
    productId: options.productId,
    checkoutUrl(reference) {
      if (!REFERENCE.test(reference)) throw new ServiceError('INVALID_REQUEST', '주문 참조값을 확인할 수 없습니다.');
      const url = new URL(base);
      url.searchParams.set('ref', reference);
      return url.href;
    },
    async verifyCompleted(raw, headers): Promise<CompletedPayment> {
      if (raw.byteLength === 0 || raw.byteLength > 256 * 1024) invalid();
      const timestamp = headers.get('x-groble-timestamp');
      const signature = headers.get('x-groble-signature');
      const previous = headers.get('x-groble-signature-previous');
      const eventKey = headers.get('x-groble-idempotency-key');
      if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || !SIGNATURE.test(signature)
        || !eventKey || eventKey.length > 256 || /[\r\n]/.test(eventKey)) invalid();
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
      const object = payload?.data?.object;
      if (payload?.type !== 'payment.completed' || payload.version !== '2026-04-30'
        || typeof payload.id !== 'string' || !payload.id || payload.id.length > 256
        || typeof payload.occurredAt !== 'string' || !Number.isFinite(Date.parse(payload.occurredAt))
        || !object || typeof object.sellerReference !== 'string' || !REFERENCE.test(object.sellerReference)
        || typeof object.merchantUid !== 'string' || !object.merchantUid || object.merchantUid.length > 256
        || object.content?.id !== options.productId || object.content?.paymentType !== 'ONE_TIME'
        || object.pricing?.currency !== 'KRW' || object.pricing?.finalAmount !== 500) invalid();
      return { reference: object.sellerReference, transactionId: object.merchantUid,
        productId: object.content.id, amount: object.pricing.finalAmount, currency: object.pricing.currency };
    },
  };
}
