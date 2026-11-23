import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { readVerifiedUser, getSchoolVerification } from './identity';
import { getServerEnv } from '@/lib/env/server';
import { ApiError } from '@/lib/http/api';

export async function requireVerifiedSchoolUser() {
  const env = getServerEnv();
  const supabase = await createClient();
  const user = await readVerifiedUser(supabase.auth);
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', '학교 이메일로 로그인해 주세요.');
  const schoolVerification = getSchoolVerification(user, env.ALLOWED_EMAIL_DOMAINS);
  if (schoolVerification.status === 'not_configured') throw new ApiError(503, 'SCHOOL_POLICY_NOT_CONFIGURED', '학교 인증 설정을 준비하고 있습니다.');
  if (schoolVerification.status !== 'verified') throw new ApiError(403, 'VERIFICATION_REQUIRED', '허용된 학교 이메일의 인증이 필요합니다.');
  return { user, supabase };
}
