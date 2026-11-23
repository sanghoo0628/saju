import { createHttpApi, type PaymentChatService } from '../../packages/payment-chat/src/http';
import { ServiceError } from '../../packages/payment-chat/src/service';
import { ApiError } from '../lib/http/api';
import { ConfigurationError } from '../lib/env/schema';

/** Preserve C's response format and raw webhook body at the Next.js boundary. */
export function createPaymentChatHandler(options: {
  service: PaymentChatService;
  appOrigin: string;
  requireUserId: () => Promise<string>;
}) {
  return createHttpApi({
    service: options.service,
    appOrigin: options.appOrigin,
    getCurrentUserId: async () => {
      try { return await options.requireUserId(); }
      catch (error) {
        if (error instanceof ConfigurationError || (error instanceof ApiError && error.status === 503))
          throw new ServiceError('PROVIDER_UNAVAILABLE', '로그인 연결 설정을 준비하고 있어요.');
        if (error instanceof ApiError && error.status === 401) return null;
        if (error instanceof ApiError && error.status === 403)
          throw new ServiceError('FORBIDDEN', '인증된 학교 계정으로 이용해주세요.');
        throw error;
      }
    },
  });
}
