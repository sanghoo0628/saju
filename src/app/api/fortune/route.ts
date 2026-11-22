import { getServerEnv } from '@/lib/env/server';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { apiHandler, assertSameOrigin, json, readJson } from '@/lib/http/api';
import { calculateFortune } from '@/features/fortune/service';
import { getFortuneServiceOptions } from '@/features/fortune/configured';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return apiHandler(async () => {
    const env = getServerEnv();
    assertSameOrigin(request, env.NEXT_PUBLIC_APP_URL);
    const { user } = await requireVerifiedSchoolUser();
    const result = await calculateFortune(await readJson(request), getFortuneServiceOptions(user.id));
    const status = result.status === 'ready' ? 200 : result.status === 'not_ready'
      ? (result.reasonCode === 'PROVIDER_NOT_CONFIGURED' ? 503 : 422)
      : result.code === 'PROVIDER_INPUT_REJECTED' ? 422 : result.code === 'PROVIDER_RATE_LIMITED' ? 429
      : result.code === 'PROVIDER_TIMEOUT' ? 504 : 502;
    return json(result, status);
  });
}
