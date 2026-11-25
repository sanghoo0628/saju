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
    // Matching storage is independent of the fortune calculation: consent + validated solar date is enough.
    // Storage failure never hides the fortune result; the client shows matchingStorage separately.
    // Start storage first (it never rejects) so a calculation/config failure cannot skip it.
    const storage = storeBirthInputIfConsented(user.id, input, getFortuneStorageRecorder);
    const result = await (async () => calculateFortune(input, getFortuneServiceOptions(user.id)))()
      .catch(async (error: unknown) => { await storage; throw error; });
    const matchingStorage = await storage;
    const status = result.status === 'ready' ? 200 : result.status === 'not_ready'
      ? (result.reasonCode === 'PROVIDER_NOT_CONFIGURED' ? 503 : 422)
      : result.code === 'PROVIDER_INPUT_REJECTED' ? 422 : ['PROVIDER_RATE_LIMITED', 'DAILY_LIMIT_REACHED', 'SERVICE_DAILY_LIMIT_REACHED'].includes(result.code) ? 429
      : result.code === 'PROVIDER_TIMEOUT' ? 504 : 502;
    return json({ ...result, matchingStorage }, status);
  });
}
