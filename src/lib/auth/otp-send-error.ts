import { ApiError } from '@/lib/http/api';

/** Expose only known delivery failures, never the provider's raw message. */
export function otpSendError(error: { status?: number; code?: string }): ApiError {
  if (error.code === 'over_email_send_rate_limit') {
    return new ApiError(429, 'RATE_LIMITED', '인증 메일 발송 한도를 초과했습니다. 반복 요청을 멈추고, 한도가 초기화되거나 운영자의 메일 발송 설정이 완료된 뒤 다시 시도해 주세요.');
  }
  if (error.code === 'email_address_not_authorized') {
    return new ApiError(503, 'AUTH_UNAVAILABLE', '현재 메일 발송 설정으로는 이 주소에 인증 메일을 보낼 수 없습니다. 운영자에게 메일 발송 설정 확인을 요청해 주세요.');
  }
  if (error.status === 429) {
    return new ApiError(429, 'RATE_LIMITED', '인증 요청이 너무 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.');
  }
  return new ApiError(503, 'AUTH_UNAVAILABLE', '인증 메일을 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}
