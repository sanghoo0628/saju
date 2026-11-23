import { ServiceError } from "./service.ts";
import type { createService } from "./service.ts";
import type { ApiErrorResponse } from "../../../contracts/payment-chat.ts";

export type PaymentChatService = ReturnType<typeof createService>;

const JSON_LIMIT = 16 * 1024;
const WEBHOOK_LIMIT = 256 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const statusFor: Record<ApiErrorResponse["code"], number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, BLOCKED: 403,
  NOT_ENOUGH_CANDIDATES: 409, ORDER_NOT_READY: 409,
  INVALID_REQUEST: 400, INVALID_WEBHOOK: 400, PROVIDER_UNAVAILABLE: 503,
  NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415, INTERNAL_ERROR: 500,
};
function fail(code: ApiErrorResponse["code"], message: string): never {
  throw new ServiceError(code, message);
}
function json(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers,
  } });
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    fail("INVALID_REQUEST", "올바른 식별자가 필요합니다.");
  return value;
}
function afterCursor(url: URL) {
  if ([...url.searchParams.keys()].some(key => key !== "afterId") || url.searchParams.getAll("afterId").length > 1)
    fail("INVALID_REQUEST", "조회 조건이 올바르지 않습니다.");
  const cursor = url.searchParams.get("afterId");
  return cursor === null ? undefined : identifier(cursor);
}
async function bodyBytes(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
    fail("PAYLOAD_TOO_LARGE", "요청 본문이 너무 큽니다.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        // 응답을 body 생산자의 cancel 완료까지 지연하지 않는다.
        void reader.cancel().catch(() => {});
        fail("PAYLOAD_TOO_LARGE", "요청 본문이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function objectBody(request: Request, fields: string[], optionalEmpty = false, optionalFields: string[] = []): Promise<Record<string,unknown>> {
  const bytes = await bodyBytes(request, JSON_LIMIT);
  if (optionalEmpty && bytes.byteLength === 0) return {};
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    fail("UNSUPPORTED_MEDIA_TYPE", "application/json 형식이 필요합니다.");
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("INVALID_REQUEST", "올바른 JSON 본문이 필요합니다."); }
  if (body === null || Array.isArray(body) || typeof body !== "object")
    fail("INVALID_REQUEST", "JSON 객체가 필요합니다.");
  if (Object.keys(body).some(key => !fields.includes(key) && !optionalFields.includes(key)) || fields.some(key => !Object.hasOwn(body, key)))
    fail("INVALID_REQUEST", "요청 필드가 올바르지 않습니다.");
  return body as Record<string,unknown>;
}

/**
 * Next.js Route Handler가 그대로 호출할 수 있는 서버 전용 Request/Response 어댑터.
 * auth는 A의 검증된 서버 세션을 연결한다. 쿠키 기반 POST에는 정확한 Origin을 요구한다.
 * 운영 DB/결제 검증기나 로그인 우회 기능은 포함하지 않는다.
 */
export function createHttpApi(deps: {
  service: PaymentChatService;
  getCurrentUserId: (request: Request) => Promise<string | null>;
  appOrigin: string;
  onUnexpectedError?: (error: unknown) => void;
}) {
  const origin = new URL(deps.appOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error("HTTP 앱 주소가 필요합니다.");
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      // 결제 웹훅은 사용자 세션/브라우저 Origin 대신 제공자 서명을 검증한다.
      if (path === "/api/webhooks/groble") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const raw = await bodyBytes(request, WEBHOOK_LIMIT);
        const result = await deps.service.paymentWebhook(raw, request.headers);
        return json(result);
      }

      const order = /^\/api\/orders\/([^/]+)$/.exec(path);
      const decision = /^\/api\/chat-requests\/([^/]+)\/(accept|reject)$/.exec(path);
      const messages = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
      const methods = path === "/api/orders" || decision ? ["POST"]
        : order || path === "/api/conversations" ? ["GET"]
        : path === "/api/chat-requests" || messages ? ["GET", "POST"] : [];
      if (!methods.length) return json({code:"NOT_FOUND",message:"API를 찾을 수 없습니다."},404);
      if (!methods.includes(request.method)) return methodNotAllowed(methods.join(", "));
      if (request.method === "POST" && request.headers.get("origin") !== origin.origin)
        fail("FORBIDDEN", "허용되지 않은 요청 출처입니다.");
      const userId = await deps.getCurrentUserId(request);
      if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
      const actor = { userId };

      if (path === "/api/orders") {
        const body = await objectBody(request, ["matchResultId"]);
        return json(await deps.service.createOrder(actor, identifier(body.matchResultId)));
      }
      if (order) return json(await deps.service.order(actor, identifier(order[1])));
      if (path === "/api/conversations") return json(await deps.service.conversations(actor, afterCursor(url)));
      if (path === "/api/chat-requests") {
        if (request.method === "GET") return json(await deps.service.requests(actor, afterCursor(url)));
        const body = await objectBody(request, ["orderId"]);
        return json(await deps.service.requestChat(actor, identifier(body.orderId)));
      }
      if (decision) {
        await objectBody(request, [], true);
        return json(await (decision[2] === "accept"
          ? deps.service.acceptChat(actor, identifier(decision[1]))
          : deps.service.rejectChat(actor, identifier(decision[1]))));
      }
      if (messages) {
        const roomId = identifier(messages[1]);
        if (request.method === "GET") {
          return json(await deps.service.messages(actor, roomId, afterCursor(url)));
        }
        const body = await objectBody(request, ["body"], false, ["clientMessageId"]);
        if (typeof body.body !== "string") fail("INVALID_REQUEST", "문자열 메시지가 필요합니다.");
        const clientMessageId = body.clientMessageId;
        if (clientMessageId !== undefined && typeof clientMessageId !== 'string')
          fail('INVALID_REQUEST', '올바른 메시지 전송 식별자가 필요합니다.');
        return json(await deps.service.sendMessage(actor, roomId, body.body, clientMessageId));
      }
      return json({code:"NOT_FOUND",message:"API를 찾을 수 없습니다."},404);
    } catch (error) {
      if (error instanceof ServiceError)
        return json({ code: error.code, message: error.message }, statusFor[error.code]);
      // DB 오류나 키가 포함될 수 있는 예외 원문은 클라이언트로 반환하지 않는다.
      try { deps.onUnexpectedError?.(error); } catch { /* 로깅 실패도 사용자에게 노출하지 않는다. */ }
      return json({ code:"INTERNAL_ERROR", message:"요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." },500);
    }
  };
}
function methodNotAllowed(allow: string) {
  return json({ code:"METHOD_NOT_ALLOWED", message:"지원하지 않는 요청 방식입니다." },405,{ Allow:allow });
}
