import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHandler } from '../../src/lib/http/api';
import { otpSendError } from '../../src/lib/auth/otp-send-error';

test('mail quota failures explain delivery limits without promising a reset time', async () => {
  const response = await apiHandler(async () => {
    throw otpSendError({ status: 429, code: 'over_email_send_rate_limit' });
  });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.match(body.error.message, /메일 발송 한도/);
  assert.match(body.error.message, /반복 요청을 멈추고/);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
});

test('default SMTP recipient restrictions request operator configuration', () => {
  const error = otpSendError({ status: 400, code: 'email_address_not_authorized' });
  assert.equal(error.status, 503);
  assert.equal(error.code, 'AUTH_UNAVAILABLE');
  assert.match(error.message, /이 주소에 인증 메일을 보낼 수 없습니다/);
});

test('other rate limits do not claim the email quota was exhausted', () => {
  const error = otpSendError({ status: 429, code: 'over_request_rate_limit' });
  assert.equal(error.status, 429);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.match(error.message, /요청이 너무 많습니다/);
  assert.doesNotMatch(error.message, /발송 한도/);
});

for (const input of [{ status: 500, code: 'unexpected_failure' }, {}]) {
  test(`unknown delivery failure stays generic: ${JSON.stringify(input)}`, () => {
    const error = otpSendError(input);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'AUTH_UNAVAILABLE');
    assert.doesNotMatch(error.message, /unexpected_failure/);
  });
}
