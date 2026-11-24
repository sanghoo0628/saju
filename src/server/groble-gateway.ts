import 'server-only';
import { ConfigurationError } from '@/lib/env/schema';
import { createGrobleEventVerifier } from './groble-events';
import { ServiceError } from '../../packages/payment-chat/src/service';
import type { CompletedPayment, PaymentGateway } from '../../packages/payment-chat/src/ports';

const REFERENCE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
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
  const verifyEvent = createGrobleEventVerifier(options);
  return {
    productId: options.productId,
    checkoutUrl(reference) {
      if (!REFERENCE.test(reference)) throw new ServiceError('INVALID_REQUEST', '주문 참조값을 확인할 수 없습니다.');
      const url = new URL(base);
      url.searchParams.set('ref', reference);
      return url.href;
    },
    async verifyCompleted(raw, headers): Promise<CompletedPayment> {
      const event = await verifyEvent(raw, headers);
      if (event.type !== 'payment.completed') return invalid();
      return { reference: event.reference, transactionId: event.transactionId,
        productId: event.productId, amount: event.amount, currency: event.currency };
    },
  };
}
