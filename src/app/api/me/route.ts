import { createClient } from '@/lib/supabase/server';
import { readVerifiedUser, getSchoolVerification } from '@/lib/auth/identity';
import { getServerEnv } from '@/lib/env/server';
import { apiHandler, ApiError, json } from '@/lib/http/api';

export const dynamic = 'force-dynamic';
export async function GET() {
  return apiHandler(async () => {
    const env = getServerEnv();
    const supabase = await createClient();
    const user = await readVerifiedUser(supabase.auth);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    return json({ userId: user.id, authenticated: true,
      schoolVerification: getSchoolVerification(user, env.ALLOWED_EMAIL_DOMAINS),
      profileStatus: 'not_connected', eligibilityStatus: 'not_ready' });
  });
}
