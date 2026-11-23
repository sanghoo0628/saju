import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ConfigurationError } from '../../src/lib/env/schema';
import { ApiError, apiHandler, assertSameOrigin, json, readJson } from '../../src/lib/http/api';

function request(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('https://app.example.test/api/fortune', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function hasApiError(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}

test('JSON parser accepts valid JSON with a charset parameter', async () => {
  assert.deepEqual(await readJson(request('{"birthDate":"2000-01-01"}', { 'Content-Type': 'application/json; charset=utf-8' })), { birthDate: '2000-01-01' });
});

test('non-JSON requests and missing request bodies are rejected', async () => {
  await assert.rejects(readJson(request('{}', { 'Content-Type': 'text/plain' })), hasApiError(415, 'JSON_REQUIRED'));
  await assert.rejects(readJson(request(null)), hasApiError(400, 'INVALID_JSON'));
});

test('malformed JSON and malformed UTF-8 are not accepted', async () => {
  await assert.rejects(readJson(request('{broken')), hasApiError(400, 'INVALID_JSON'));
  await assert.rejects(readJson(request(new Uint8Array([0x22, 0xc0, 0xaf, 0x22]))), hasApiError(400, 'INVALID_JSON'));
});

test('payload limit counts UTF-8 bytes rather than characters', async () => {
  await assert.rejects(readJson(request('"가나다"'), 8), hasApiError(413, 'PAYLOAD_TOO_LARGE'));
  assert.equal(await readJson(request('"가나"'), 8), '가나');
});

test('lying Content-Length cannot bypass the body limit', async () => {
  await assert.rejects(readJson(request(JSON.stringify({ text: 'x'.repeat(100) }), { 'Content-Length': '2' }), 32), hasApiError(413, 'PAYLOAD_TOO_LARGE'));
});

test('streamed payloads are rejected and cancelled once the limit is reached', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"')); },
    pull(controller) { controller.enqueue(new Uint8Array(32).fill(97)); },
    cancel() { cancelled = true; },
  });
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/json' },
  };
  await assert.rejects(readJson(new Request('https://app.example.test/api/fortune', init), 16), hasApiError(413, 'PAYLOAD_TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('mutation origin must be present and match the configured origin', () => {
  assert.doesNotThrow(() => assertSameOrigin(request('{}', { Origin: 'https://app.example.test' }), 'https://app.example.test/'));
  for (const origin of [undefined, 'null', 'https://app.example.test.evil', 'http://app.example.test', 'https://app.example.test:444']) {
    const headers: Record<string, string> = origin ? { Origin: origin } : {};
    assert.throws(() => assertSameOrigin(request('{}', headers), 'https://app.example.test'), hasApiError(403, 'INVALID_ORIGIN'));
  }
});

test('private JSON responses and controlled errors are never cached', async () => {
  const ok = json({ userId: 'private-user' });
  const denied = await apiHandler(async () => { throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.'); });
  for (const response of [ok, denied]) {
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
  }
  assert.equal(denied.status, 401);
});

test('configuration and upstream errors do not leak secrets or raw private data', async () => {
  const secret = 'RAW_BIRTH_AND_SECRET_TEST_MARKER';
  const misconfigured = await apiHandler(async () => { throw new ConfigurationError([secret]); });
  const upstream = await apiHandler(async () => { throw new Error(secret); });
  assert.equal(misconfigured.status, 503);
  assert.equal(upstream.status, 500);
  for (const response of [misconfigured, upstream]) {
    assert.equal((await response.text()).includes(secret), false);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('validation responses identify fields without returning submitted values', async () => {
  const privateValue = 'private-birth-input';
  const response = await apiHandler(async () => {
    z.object({ age: z.number() }).parse({ age: privateValue });
    return json({});
  });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.deepEqual(result.error.fields, ['age']);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
});
