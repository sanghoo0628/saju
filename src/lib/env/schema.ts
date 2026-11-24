import { z } from 'zod';

const optionalText = z.preprocess((v) => v === '' ? undefined : v, z.string().optional());
const optionalUrl = z.preprocess((v) => v === '' ? undefined : v, z.url().optional());
const flag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');

export class ConfigurationError extends Error {
  constructor(public readonly fields: string[]) {
    super(`설정이 필요합니다: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

const serverSchema = z.object({
  APP_ENV: z.enum(['development', 'preview', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalText,
  SUPABASE_SECRET_KEY: optionalText,
  ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  SAJU_PROVIDER: z.enum(['mock', 'unconfigured', 'hrum']).default('unconfigured'),
  SAJU_FINGERPRINT_SECRET: optionalText,
  SAJU_API_BASE_URL: optionalUrl,
  SAJU_API_KEY: optionalText,
  PAYMENTS_ENABLED: flag,
  MOCK_PAYMENTS_ENABLED: flag,
  MATCHING_STRATEGY: z.enum(['legacy_demo_v1', 'saju_hybrid_v0_1']).optional(),
  // B legacy score HMAC key. Server-only, separate from SAJU_FINGERPRINT_SECRET.
  SCORE_HMAC_SECRET: optionalText,
  ACTIVITY_BOOKING_PROVIDER: z.enum(['disabled']).default('disabled'),
}).superRefine((v, ctx) => {
  const issue = (field: string) => ctx.addIssue({ code: 'custom', path: [field], message: 'Invalid configuration' });
  if (!!v.NEXT_PUBLIC_SUPABASE_URL !== !!v.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) issue('NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (v.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && !v.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) issue('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (v.SAJU_FINGERPRINT_SECRET && v.SAJU_FINGERPRINT_SECRET.length < 32) issue('SAJU_FINGERPRINT_SECRET');
  if (v.SCORE_HMAC_SECRET && v.SCORE_HMAC_SECRET.length < 32) issue('SCORE_HMAC_SECRET');
  if (v.SAJU_API_BASE_URL && v.SAJU_API_BASE_URL.replace(/\/$/, '') !== 'https://api.hrum.ai/api/v1/partners/v1') issue('SAJU_API_BASE_URL');
  if (v.SAJU_PROVIDER === 'hrum' && v.SAJU_API_KEY && !v.SAJU_FINGERPRINT_SECRET) issue('SAJU_FINGERPRINT_SECRET');
  if (v.SAJU_API_KEY && /[\r\n\s]/.test(v.SAJU_API_KEY)) issue('SAJU_API_KEY');
  const domains = v.ALLOWED_EMAIL_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  if (domains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(d))) issue('ALLOWED_EMAIL_DOMAINS');
  let appUrl: URL;
  try { appUrl = new URL(v.NEXT_PUBLIC_APP_URL); } catch { return; }
  if (appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) issue('NEXT_PUBLIC_APP_URL');
  if (v.APP_ENV === 'development' && !['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname)) issue('APP_ENV');
  if (v.APP_ENV === 'preview' && appUrl.protocol !== 'https:') issue('NEXT_PUBLIC_APP_URL');
  // C's payment module has not been integrated; no success switch in the A shell.
  if (v.PAYMENTS_ENABLED || v.MOCK_PAYMENTS_ENABLED) issue('PAYMENTS_ENABLED/MOCK_PAYMENTS_ENABLED');
  if (v.APP_ENV === 'production') {
    if (appUrl.protocol !== 'https:') issue('NEXT_PUBLIC_APP_URL');
    if (!v.NEXT_PUBLIC_SUPABASE_URL) issue('NEXT_PUBLIC_SUPABASE_URL');
    if (v.NEXT_PUBLIC_SUPABASE_URL && !v.NEXT_PUBLIC_SUPABASE_URL.startsWith('https://')) issue('NEXT_PUBLIC_SUPABASE_URL');
    if (!domains.length) issue('ALLOWED_EMAIL_DOMAINS');
    if (v.SAJU_PROVIDER === 'mock') issue('SAJU_PROVIDER');
    if (!v.MATCHING_STRATEGY) issue('MATCHING_STRATEGY');
    if (v.MATCHING_STRATEGY === 'legacy_demo_v1' && !v.SCORE_HMAC_SECRET) issue('SCORE_HMAC_SECRET');
  }
});

export function parseServerEnv(source: Record<string, string | undefined>) {
  const result = serverSchema.safeParse(source);
  if (!result.success) throw new ConfigurationError([...new Set(result.error.issues.map(i => i.path.join('.')))]);
  if (source.VERCEL_ENV === 'production' && result.data.APP_ENV !== 'production')
    throw new ConfigurationError(['APP_ENV']);
  return result.data;
}
