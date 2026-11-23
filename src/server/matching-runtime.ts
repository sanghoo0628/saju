import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { getServerEnv } from '@/lib/env/server';
import { ApiError, apiHandler } from '@/lib/http/api';
import { createMatchingService, MatchingError } from './matching-service';
import { createSupabaseMatchingStore } from './supabase-store';

export function getMatchingService() {
  if (getServerEnv().MATCHING_STRATEGY !== 'legacy_demo_v1')
    throw new ApiError(503, 'MATCHING_NOT_CONFIGURED', '추천 연결을 준비하고 있어요.');
  return createMatchingService(createSupabaseMatchingStore(createAdminClient()));
}

export function matchingApiHandler(operation: () => Promise<Response>) {
  return apiHandler(async () => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MatchingError)
        throw new ApiError(error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORTUNE_REQUIRED' ? 409 : 400, error.code, error.message);
      throw error;
    }
  });
}
