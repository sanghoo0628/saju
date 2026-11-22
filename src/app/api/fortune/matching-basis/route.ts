import { getServerEnv } from '@/lib/env/server';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { apiHandler, assertSameOrigin, json, readJson } from '@/lib/http/api';
import { getFortuneServiceOptions } from '@/features/fortune/configured';
import { calculateFortuneForMatching } from '@/features/fortune/matching-input';

export const runtime = 'nodejs';

/** Explicit second calculation; preparing B's input does not run a matching strategy. */
export async function POST(request: Request) {
  return apiHandler(async () => {
    const env = getServerEnv();
    assertSameOrigin(request, env.NEXT_PUBLIC_APP_URL);
    const { user } = await requireVerifiedSchoolUser();
    const result = await calculateFortuneForMatching(await readJson(request), getFortuneServiceOptions(user.id));
    const status = result.status === 'ready' ? 200
      : result.reasonCode === 'PROVIDER_NOT_CONFIGURED' ? 503
      : result.reasonCode === 'PROVIDER_RATE_LIMITED' ? 429
      : result.reasonCode === 'PROVIDER_TIMEOUT' ? 504
      : ['PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH_FAILED', 'PROVIDER_QUOTA_EXCEEDED', 'INVALID_PROVIDER_RESPONSE'].includes(result.reasonCode) ? 502
      : 422;
    return json(result, status);
  });
}
