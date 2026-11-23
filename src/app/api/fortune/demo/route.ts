import { getServerEnv } from '@/lib/env/server';
import { apiHandler, ApiError, json } from '@/lib/http/api';
import { calculateFortune } from '@/features/fortune/service';
import { createMockFortuneProvider } from '@/features/fortune/providers/mock';

export const dynamic = 'force-dynamic';
export async function GET() {
  return apiHandler(async () => {
    if (getServerEnv().APP_ENV !== 'development') throw new ApiError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
    return json(await calculateFortune({ birthDate: '2000-01-01', birthTime: null, calendar: 'solar', isLeapMonth: false, timezone: 'Asia/Seoul', providerSex: 'unspecified', consent: true }, {
      userId: 'public-demo-fixture', provider: createMockFortuneProvider(),
      fingerprintSecret: 'public-static-fixture-no-user-data-v1',
    }));
  });
}
