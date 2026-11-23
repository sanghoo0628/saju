import assert from 'node:assert/strict';
import test from 'node:test';
import { emailOtpTokenSchema } from '../../src/lib/auth/email-otp';

for (const length of [6, 8, 10]) {
  test(`email OTP accepts a ${length}-digit project token`, () => {
    assert.equal(emailOtpTokenSchema.parse('0'.repeat(length)), '0'.repeat(length));
  });
}
for (const token of ['12345', '12345678901', '1234a678', ' 123456 ', 123456]) {
  test(`email OTP rejects malformed input ${JSON.stringify(token)}`, () => {
    assert.equal(emailOtpTokenSchema.safeParse(token).success, false);
  });
}
