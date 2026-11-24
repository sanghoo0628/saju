import assert from 'node:assert/strict';
import test from 'node:test';
import { getSchoolVerification, isAllowedSchoolEmail, readVerifiedUser, type VerifiedUser } from '../../src/lib/auth/identity';
import { ConfigurationError, parseServerEnv } from '../../src/lib/env/schema';

const verifiedUser: VerifiedUser = {
  id: 'f068a332-2b53-4c35-9ac9-94c2d08e3d94',
  email: 'student@campus.example.edu',
  email_confirmed_at: '2026-11-16T01:00:00Z',
  is_anonymous: false,
};

test('server identity uses the verified Auth user UUID', async () => {
  let calls = 0;
  const result = await readVerifiedUser({ getUser: async () => {
    calls += 1;
    return { data: { user: verifiedUser }, error: null };
  } });
  assert.equal(calls, 1);
  assert.equal(result?.id, verifiedUser.id);
});

test('a claimed session identity cannot replace a missing verified user', async () => {
  const response = {
    data: { user: null, session: { user: verifiedUser } },
    error: null,
  };
  assert.equal(await readVerifiedUser({ getUser: async () => response }), null);
});

test('Auth errors reject identity even when the response contains a user', async () => {
  assert.equal(await readVerifiedUser({ getUser: async () => ({
    data: { user: verifiedUser }, error: new Error('Auth unavailable'),
  }) }), null);
});

test('Auth exceptions fail closed', async () => {
  assert.equal(await readVerifiedUser({ getUser: async () => {
    throw new Error('network failure');
  } }), null);
});

test('anonymous Auth users do not become application members', async () => {
  assert.equal(await readVerifiedUser({ getUser: async () => ({
    data: { user: { ...verifiedUser, is_anonymous: true } }, error: null,
  }) }), null);
});

test('invalid UUIDs cannot become server user identities', async () => {
  assert.equal(await readVerifiedUser({ getUser: async () => ({
    data: { user: { ...verifiedUser, id: 'buyer-id-from-request' } }, error: null,
  }) }), null);
});

test('verified email alone does not grant school verification', () => {
  assert.deepEqual(getSchoolVerification(verifiedUser, 'another.example.edu'), { status: 'domain_not_allowed' });
  assert.deepEqual(getSchoolVerification({ ...verifiedUser, email: undefined }, 'campus.example.edu'), { status: 'domain_not_allowed' });
});

test('matching school email must actually be confirmed', () => {
  assert.deepEqual(getSchoolVerification({ ...verifiedUser, email_confirmed_at: undefined }, 'campus.example.edu'), { status: 'email_unverified' });
});

test('an empty school allowlist never allows every email', () => {
  assert.deepEqual(getSchoolVerification(verifiedUser, ' ,  ,'), { status: 'not_configured' });
});

test('school domains match exactly and case-insensitively', () => {
  assert.deepEqual(getSchoolVerification({ ...verifiedUser, email: 'Student@CAMPUS.EXAMPLE.EDU' }, ' campus.example.edu , second.example.edu '), { status: 'verified' });
  for (const email of ['student@campus.example.edu.evil', 'student@sub.campus.example.edu', 'student@evilcampus.example.edu', 'bad@@campus.example.edu']) {
    assert.equal(isAllowedSchoolEmail(email, ['campus.example.edu']), false);
  }
});

const productionEnv = {
  APP_ENV: 'production',
  NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only',
  ALLOWED_EMAIL_DOMAINS: 'campus.example.edu',
  MATCHING_STRATEGY: 'saju_hybrid_v0_1',
};

test('no-key local configuration stays unconfigured with payments disabled', () => {
  const env = parseServerEnv({});
  assert.equal(env.SAJU_PROVIDER, 'unconfigured');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, undefined);
  assert.equal(env.PAYMENTS_ENABLED, false);
  assert.equal(env.MOCK_PAYMENTS_ENABLED, false);
});

test('Supabase URL and publishable key must be configured together', () => {
  assert.throws(() => parseServerEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test' }), ConfigurationError);
  assert.throws(() => parseServerEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only' }), ConfigurationError);
});

test('a server secret cannot be supplied as the browser publishable key', () => {
  const secret = 'sb_secret_DO_NOT_EXPOSE_TEST_MARKER';
  let observed: unknown;
  try { parseServerEnv({ ...productionEnv, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret }); }
  catch (error) { observed = error; }
  assert.ok(observed instanceof ConfigurationError);
  assert.ok(observed.fields.includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
  assert.equal(String(observed).includes(secret), false);
  assert.equal(JSON.stringify(observed).includes(secret), false);
});

test('A shell cannot enable either live or mock payments', () => {
  assert.throws(() => parseServerEnv({ PAYMENTS_ENABLED: 'true' }), ConfigurationError);
  assert.throws(() => parseServerEnv({ MOCK_PAYMENTS_ENABLED: 'true' }), ConfigurationError);
});

test('production requires explicit strategy and a school allowlist', () => {
  assert.throws(() => parseServerEnv({ ...productionEnv, MATCHING_STRATEGY: undefined }), ConfigurationError);
  assert.throws(() => parseServerEnv({ ...productionEnv, ALLOWED_EMAIL_DOMAINS: '' }), ConfigurationError);
  assert.equal(parseServerEnv(productionEnv).APP_ENV, 'production');
});

test('production rejects mock fortunes and insecure app/Auth origins', () => {
  assert.throws(() => parseServerEnv({ ...productionEnv, SAJU_PROVIDER: 'mock' }), ConfigurationError);
  assert.throws(() => parseServerEnv({ ...productionEnv, NEXT_PUBLIC_APP_URL: 'http://app.example.test' }), ConfigurationError);
  assert.throws(() => parseServerEnv({ ...productionEnv, NEXT_PUBLIC_SUPABASE_URL: 'http://project.example.test' }), ConfigurationError);
});

test('app origin rejects embedded credentials, paths and query fragments', () => {
  for (const url of ['https://user:secret@example.test', 'https://example.test/path', 'https://example.test?return=evil', 'https://example.test#fragment']) {
    assert.throws(() => parseServerEnv({ NEXT_PUBLIC_APP_URL: url }), ConfigurationError);
  }
});

test('school configuration cannot contain wildcards or URL-shaped domains', () => {
  for (const domain of ['*.example.edu', 'https://campus.example.edu', 'campus.example.edu/path']) {
    assert.throws(() => parseServerEnv({ ALLOWED_EMAIL_DOMAINS: domain }), ConfigurationError);
  }
});

test('short fingerprint secrets fail without exposing their values', () => {
  const secret = 'short-sensitive';
  assert.throws(() => parseServerEnv({ SAJU_FINGERPRINT_SECRET: secret }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('development fixtures cannot be enabled for a public application URL', () => {
  assert.throws(() => parseServerEnv({ NEXT_PUBLIC_APP_URL: 'https://public.example.test', SAJU_PROVIDER: 'mock' }), ConfigurationError);
  assert.equal(parseServerEnv({ APP_ENV: 'development', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }).APP_ENV, 'development');
});

test('malformed app URLs remain sanitized configuration errors', () => {
  assert.throws(() => parseServerEnv({ NEXT_PUBLIC_APP_URL: 'not-a-url' }), ConfigurationError);
});

test('HRUM may remain unconfigured without a key, but an active key requires a private fingerprint secret', () => {
  assert.equal(parseServerEnv({ SAJU_PROVIDER: 'hrum' }).SAJU_API_KEY, undefined);
  assert.equal(parseServerEnv({ SAJU_PROVIDER: 'hrum', SAJU_API_KEY: '' }).SAJU_API_KEY, undefined);
  assert.throws(() => parseServerEnv({ SAJU_PROVIDER: 'hrum', SAJU_API_KEY: 'test-only-key' }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(error.fields.includes('SAJU_FINGERPRINT_SECRET'));
    assert.equal(error.message.includes('test-only-key'), false);
    return true;
  });
  const env = parseServerEnv({ SAJU_PROVIDER: 'hrum', SAJU_API_KEY: 'test-only-key', SAJU_FINGERPRINT_SECRET: 'unit-test-private-fingerprint-secret-32-characters' });
  assert.equal(env.SAJU_PROVIDER, 'hrum');
  assert.equal(env.SAJU_API_KEY, 'test-only-key');
});

test('HRUM API origin is pinned and rejects alternate hosts, credentials, paths and query overrides', () => {
  for (const url of [undefined, '', 'https://api.hrum.ai/api/v1/partners/v1', 'https://api.hrum.ai/api/v1/partners/v1/']) {
    assert.doesNotThrow(() => parseServerEnv({ SAJU_API_BASE_URL: url }));
  }
  for (const url of [
    'http://api.hrum.ai/api/v1/partners/v1',
    'https://api.hrum.ai.evil.example/api/v1/partners/v1',
    'https://user:private-value@api.hrum.ai/api/v1/partners/v1',
    'https://api.hrum.ai/api/v1/partners/v1/guest',
    'https://api.hrum.ai/api/v1/partners/v1?forward=private-value',
    'https://api.hrum.ai/api/v1/partners/v1#private-value',
    'https://api.hrum.ai:8443/api/v1/partners/v1',
  ]) {
    assert.throws(() => parseServerEnv({ SAJU_API_BASE_URL: url }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.fields.includes('SAJU_API_BASE_URL'));
      assert.equal(error.message.includes(url), false);
      assert.equal(JSON.stringify(error).includes('private-value'), false);
      return true;
    });
  }
});

test('HRUM key header-injection and whitespace errors never expose the credential value', () => {
  for (const key of ['private-value\r\nInjected: header', ' private-value', 'private-value ', 'private\tvalue', 'private\nvalue']) {
    assert.throws(() => parseServerEnv({ SAJU_PROVIDER: 'hrum', SAJU_API_KEY: key, SAJU_FINGERPRINT_SECRET: 'unit-test-private-fingerprint-secret-32-characters' }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.fields.includes('SAJU_API_KEY'));
      assert.equal(error.message.includes(key), false);
      assert.equal(JSON.stringify(error).includes('private-value'), false);
      return true;
    });
  }
});

test('HTTPS preview accepts an explicitly labelled mock without relaxing production', () => {
  const preview = parseServerEnv({APP_ENV:'preview',NEXT_PUBLIC_APP_URL:'https://saju-preview.example.test',SAJU_PROVIDER:'mock'});
  assert.equal(preview.APP_ENV,'preview');
  assert.equal(preview.SAJU_PROVIDER,'mock');
  assert.equal(preview.PAYMENTS_ENABLED,false);
  assert.throws(()=>parseServerEnv({APP_ENV:'preview',NEXT_PUBLIC_APP_URL:'http://saju-preview.example.test'}),ConfigurationError);
  assert.throws(()=>parseServerEnv({...productionEnv,SAJU_PROVIDER:'mock'}),ConfigurationError);
});

test('Vercel production cannot silently run with development or preview sample settings', () => {
  assert.throws(()=>parseServerEnv({VERCEL_ENV:'production',APP_ENV:'preview',NEXT_PUBLIC_APP_URL:'https://saju.example.test',SAJU_PROVIDER:'mock'}),ConfigurationError);
  assert.equal(parseServerEnv({...productionEnv,VERCEL_ENV:'production'}).APP_ENV,'production');
});
