import { getServerEnv } from '@/lib/env/server';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { apiHandler, assertSameOrigin, json, readJson } from '@/lib/http/api';
import { fortuneInputSchema } from '@/features/fortune/schema';
import { calculateFortune } from '@/features/fortune/service';
import { getFortuneServiceOptions } from '@/features/fortune/configured';
import { storeBirthInputIfConsented } from '@/features/fortune/storage';
import { getFortuneStorageRecorder } from '@/features/fortune/storage-runtime';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return apiHandler(async () => {
    const env = getServerEnv();
    assertSameOrigin(request, env.NEXT_PUBLIC_APP_URL);
    const { user } = await requireVerifiedSchoolUser();
    const input = fortuneInputSchema.parse(await readJson(request));
    const result = await calculateFortune(input, getFortuneServiceOptions(user.id));
    // Storage failure never hides the fortune result; the client shows matchingStorage separately.
    const matchingStorage = await storeBirthInputIfConsented(user.id, input, result, getFortuneStorageRecorder);
    const status = result.status === 'ready' ? 200 : result.status === 'not_ready'
      ? (result.reasonCode === 'PROVIDER_NOT_CONFIGURED' ? 503 : 422)
      : result.code === 'PROVIDER_INPUT_REJECTED' ? 422 : result.code === 'PROVIDER_RATE_LIMITED' ? 429
      : result.code === 'PROVIDER_TIMEOUT' ? 504 : 502;
    return json({ ...result, matchingStorage }, status);
  });
}
