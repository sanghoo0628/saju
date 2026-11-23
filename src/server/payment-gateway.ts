import { ServiceError } from '../../packages/payment-chat/src/service';
import type { PaymentGateway } from '../../packages/payment-chat/src/ports';

/** Official Groble verification is still pending. Existing chat rights remain usable. */
export const unavailablePaymentGateway: PaymentGateway = {
  productId: 'unconfigured',
  checkoutUrl() { throw new ServiceError('PROVIDER_UNAVAILABLE', '결제 연결을 준비하고 있어요. 기존 대화와 받은 요청은 이용할 수 있어요.'); },
  async verifyCompleted() { throw new ServiceError('PROVIDER_UNAVAILABLE', '결제 확인 연결을 준비하고 있어요.'); },
};
