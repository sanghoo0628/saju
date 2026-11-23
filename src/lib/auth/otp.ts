import 'server-only';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env/server';
import { createClient } from '@/lib/supabase/server';
import { isAllowedSchoolEmail, readVerifiedUser, getSchoolVerification } from './identity';
import { apiHandler, ApiError, assertSameOrigin, json, readJson } from '@/lib/http/api';
import { emailOtpTokenSchema } from './email-otp';
import { otpSendError, otpVerifyError } from './otp-send-error';

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const loginSchema = z.object({ email: emailSchema }).strict();
const verifySchema = z.object({ email: emailSchema, token: emailOtpTokenSchema }).strict();

export function handleOtp(request: Request, mode: 'send' | 'verify') {
  return apiHandler(async () => {
    const env = getServerEnv();
    assertSameOrigin(request, env.NEXT_PUBLIC_APP_URL);
    const body = await readJson(request);
    const input: { email: string; token?: string } = mode === 'send' ? loginSchema.parse(body) : verifySchema.parse(body);
    const domains = env.ALLOWED_EMAIL_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
    if (!domains.length) throw new ApiError(503, 'SCHOOL_POLICY_NOT_CONFIGURED', '학교 인증 설정을 준비하고 있습니다.');
    if (!isAllowedSchoolEmail(input.email, domains)) throw new ApiError(403, 'EMAIL_DOMAIN_NOT_ALLOWED', '허용된 학교 이메일을 입력해 주세요.');
    const supabase = await createClient();
    if (mode === 'send') {
      const { error } = await supabase.auth.signInWithOtp({ email: input.email, options: { shouldCreateUser: true } });
      if (error) throw otpSendError(error);
    } else {
      if (input.token === undefined) throw new ApiError(400, 'INVALID_OTP', '인증 코드가 올바르지 않거나 만료되었습니다.');
      const { error } = await supabase.auth.verifyOtp({ email: input.email, token: input.token, type: 'email' });
      if (error) throw otpVerifyError(error);
      const user = await readVerifiedUser(supabase.auth);
      if (!user || getSchoolVerification(user, env.ALLOWED_EMAIL_DOMAINS).status !== 'verified') {
        await supabase.auth.signOut({ scope: 'local' });
        throw new ApiError(403, 'VERIFICATION_REQUIRED', '학교 이메일 인증을 완료하지 못했습니다.');
      }
    }
    return json({ ok: true });
  });
}
