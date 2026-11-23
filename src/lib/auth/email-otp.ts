import { z } from 'zod';

// Supabase projects support configurable email OTP lengths from 6 to 10.
// The Auth server still verifies the project's actual token, expiry and rate limits.
export const EMAIL_OTP_MIN_LENGTH = 6;
export const EMAIL_OTP_MAX_LENGTH = 10;
export const EMAIL_OTP_INPUT_PATTERN = '[0-9]{6,10}';
export const emailOtpTokenSchema = z.string().regex(new RegExp(`^${EMAIL_OTP_INPUT_PATTERN}$`));
