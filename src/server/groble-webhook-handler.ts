/** Standalone ingress factory; deliberately not wired into the deployed route yet. */
import { ServiceError } from '../../packages/payment-chat/src/service';
import type { GrobleInboxResult } from './groble-inbox';

const LIMIT = 256 * 1024;
const response = (status: number, code: string, extra: Record<string, string> = {}) =>
  Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
class InputError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
async function rawBody(request: Request, readTimeoutMs: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMIT))
    throw new InputError(413, 'PAYLOAD_TOO_LARGE');
  if (!request.body) throw new InputError(400, 'INVALID_WEBHOOK');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new InputError(408, 'BODY_TIMEOUT'));
      void reader.cancel().catch(() => {});
    }, readTimeoutMs);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        void reader.cancel().catch(() => {});
        throw new InputError(413, 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
    if (!size) throw new InputError(400, 'INVALID_WEBHOOK');
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function createGrobleWebhookHandler(options: {
  /** Must resolve only after a durable transaction commit, never after scheduling background work. */
  receive(raw: Uint8Array, headers: Headers): Promise<GrobleInboxResult>;
  onUnexpectedError?: (error: unknown) => void;
  /** Total body-read budget. DB deadlines and platform limits must be set independently at rollout. */
  readTimeoutMs?: number;
}) {
  const timeout = options.readTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) throw new Error('Invalid webhook read budget');
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== '/api/webhooks/groble') return response(404, 'NOT_FOUND');
    if (request.method !== 'POST') return response(405, 'METHOD_NOT_ALLOWED', { Allow: 'POST' });
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      return response(415, 'UNSUPPORTED_MEDIA_TYPE');
    try {
      const raw = await rawBody(request, timeout);
      // No cookie, school-user or browser Origin dependency. Authentication is the raw-body signature.
      const result = await options.receive(raw, request.headers);
      if (!['applied','pending_mapping','review_required'].includes(result.state)) throw new Error('Invalid durable inbox result');
      // Pending/review events are already durable. Retry is for failed storage, not unresolved policy.
      return response(result.state === 'applied' ? 200 : 202, 'EVENT_RECEIVED');
    } catch (error) {
      if (error instanceof InputError) return response(error.status, error.code);
      if (error instanceof ServiceError && ['INVALID_WEBHOOK','INVALID_REQUEST'].includes(error.code))
        return response(400, 'INVALID_WEBHOOK');
      // Never expose DB messages, signed payloads, identifiers, headers or credentials.
      try { options.onUnexpectedError?.(error); } catch { /* Diagnostics cannot change acknowledgement. */ }
      return response(503, 'PROVIDER_UNAVAILABLE', { 'Retry-After': '5' });
    }
  };
}
