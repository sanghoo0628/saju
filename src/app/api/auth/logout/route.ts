import { createClient } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/server';
import { apiHandler, ApiError, assertSameOrigin, json } from '@/lib/http/api';

export async function POST(request: Request) {
  return apiHandler(async () => {
    assertSameOrigin(request, getServerEnv().NEXT_PUBLIC_APP_URL);
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw new ApiError(503, 'AUTH_UNAVAILABLE', '로그아웃을 완료하지 못했습니다. 다시 시도해 주세요.');
    return json({ ok: true });
  });
}
