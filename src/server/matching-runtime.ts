import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { getServerEnv } from '@/lib/env/server';
import { ApiError, apiHandler } from '@/lib/http/api';
import type { MatchingErrorCode } from '@/contracts/matching';
import { createMatchingService, MatchingError } from './matching-service';
import { createSupabaseMatchingStore } from './supabase-store';

export function getMatchingService() {
  const env = getServerEnv();
  if (env.MATCHING_STRATEGY !== 'legacy_demo_v1')
    throw new ApiError(503, 'MATCHING_NOT_CONFIGURED', '추천 연결을 준비하고 있어요.');
  return createMatchingService(createSupabaseMatchingStore(createAdminClient()), { scoreSecret: env.SCORE_HMAC_SECRET });
}

const MATCHING_ERROR_STATUS: Record<MatchingErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_REQUEST: 400,
  FORTUNE_REQUIRED: 409,
  TRACK_REQUIRED: 400,
  TRACK_LOCKED: 409,
  NOT_CONFIGURED: 503,
};

export function matchingApiHandler(operation: () => Promise<Response>) {
  return apiHandler(async () => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MatchingError)
        throw new ApiError(MATCHING_ERROR_STATUS[error.code], error.code, error.message);
      throw error;
    }
  });
}
