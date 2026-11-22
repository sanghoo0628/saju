import { z } from 'zod';
import { ConfigurationError } from '@/lib/env/schema';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
}

export async function apiHandler(operation: () => Promise<Response>) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof ConfigurationError) return json({ error: { code: 'SERVICE_NOT_CONFIGURED', message: '서비스 연결 설정을 준비하고 있습니다.' } }, 503);
    if (error instanceof z.ZodError) return json({ error: { code: 'INVALID_INPUT', message: '입력 내용을 확인해 주세요.', fields: error.issues.map(i => i.path.join('.')) } }, 400);
    // Do not log raw errors: upstream errors can include birth input or credentials.
    return json({ error: { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' } }, 500);
  }
}

export function assertSameOrigin(request: Request, appUrl: string) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(appUrl).origin) throw new ApiError(403, 'INVALID_ORIGIN', '요청 출처를 확인하지 못했습니다.');
}

export async function readJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED', 'JSON 요청이 필요합니다.');
  if (!request.body) throw new ApiError(400, 'INVALID_JSON', '입력 내용을 확인해 주세요.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '입력 내용이 너무 큽니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', '입력 내용을 확인해 주세요.'); }
}
