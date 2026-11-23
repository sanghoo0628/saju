import type {
  ApiErrorResponse, ChatMessage, ChatRequestResponse, ConversationResponse,
  CreateOrderResponse, OrderResponse,
} from "../../../contracts/payment-chat.ts";
import { schedule, type Schedule } from "./message-source.ts";

export class PaymentChatClientError extends Error {
  code: ApiErrorResponse["code"] | "INVALID_RESPONSE" | "REQUEST_TIMEOUT";
  status: number;
  constructor(code: PaymentChatClientError["code"], message: string, status: number) {
    super(message);
    this.name = "PaymentChatClientError";
    this.code = code;
    this.status = status;
  }
}

/** 브라우저용. 로그인 쿠키를 사용하는 같은 출처의 API만 호출한다. */
export function createBrowserRequest(fetcher: typeof fetch = fetch, options: {
  timeoutMs?: number;
  schedule?: Schedule;
} = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error("Invalid API request timeout");
  const later = options.schedule ?? schedule;
  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let removeAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", stop);
    });
    const cancelTimeout = later(() => controller.abort(new PaymentChatClientError(
      "REQUEST_TIMEOUT", "응답이 지연되고 있어요. 처리 여부를 확인한 뒤 다시 시도해주세요.", 408,
    )), timeoutMs);
    // Bound both headers and JSON reading, even if a transport ignores cancellation.
    // A timeout does not prove a write failed. Never retry a POST here.
    const work = async () => {
      const response = await fetcher(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(body !== undefined ? { headers: {"Content-Type":"application/json"}, body:JSON.stringify(body) } : {}),
      });
      controller.signal.throwIfAborted();
      let payload;
      try { payload = await response.json(); }
      catch {
        controller.signal.throwIfAborted();
        throw new PaymentChatClientError("INVALID_RESPONSE","서버 응답을 확인할 수 없습니다.",response.status);
      }
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const failure = typeof payload?.code === "string" ? payload : payload?.error;
        throw new PaymentChatClientError(
          typeof failure?.code === "string" ? failure.code : "INTERNAL_ERROR",
          typeof failure?.message === "string" ? failure.message : "요청을 처리하지 못했습니다.",
          response.status,
        );
      }
      return payload as T;
    };
    try { return await Promise.race([work(), aborted]); }
    finally {
      cancelTimeout();
      removeAbort();
      signal?.removeEventListener("abort", cancel);
    }
  }
  return call;
}

export function createBrowserClient(fetcher: typeof fetch = fetch, options: {
  timeoutMs?: number;
  schedule?: Schedule;
} = {}) {
  const call = createBrowserRequest(fetcher, options);
  const segment = (id: string) => encodeURIComponent(id);
  const after = (id?: string) => id === undefined ? "" : `?afterId=${encodeURIComponent(id)}`;
  return {
    createOrder: (matchResultId: string, signal?: AbortSignal) => call<CreateOrderResponse>("/api/orders", {matchResultId}, signal),
    order: (orderId: string, signal?: AbortSignal) => call<OrderResponse>(`/api/orders/${segment(orderId)}`, undefined, signal),
    requestChat: (orderId: string, signal?: AbortSignal) => call<ChatRequestResponse>("/api/chat-requests", {orderId}, signal),
    requests: (afterId?: string, signal?: AbortSignal) => call<ChatRequestResponse[]>(`/api/chat-requests${after(afterId)}`,undefined,signal),
    acceptChat: (requestId: string, signal?: AbortSignal) => call<{conversationId:string}>(`/api/chat-requests/${segment(requestId)}/accept`,{},signal),
    rejectChat: (requestId: string, signal?: AbortSignal) => call<ChatRequestResponse>(`/api/chat-requests/${segment(requestId)}/reject`,{},signal),
    conversations: (afterId?: string, signal?: AbortSignal) => call<ConversationResponse[]>(`/api/conversations${after(afterId)}`,undefined,signal),
    sendMessage: (conversationId: string, body: string, signal?: AbortSignal, clientMessageId?: string) => call<ChatMessage>(`/api/conversations/${segment(conversationId)}/messages`,{body,...(clientMessageId === undefined ? {} : {clientMessageId})},signal),
    messages: (conversationId: string, afterId?: string, signal?: AbortSignal) => call<ChatMessage[]>(`/api/conversations/${segment(conversationId)}/messages${after(afterId)}`,undefined,signal),
  };
}
