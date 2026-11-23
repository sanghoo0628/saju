import type {
  ApiErrorResponse, ChatMessage, ChatRequestResponse, ConversationResponse,
  CreateOrderResponse, OrderResponse,
} from "../../../contracts/payment-chat.ts";

export class PaymentChatClientError extends Error {
  code: ApiErrorResponse["code"] | "INVALID_RESPONSE";
  status: number;
  constructor(code: PaymentChatClientError["code"], message: string, status: number) {
    super(message);
    this.name = "PaymentChatClientError";
    this.code = code;
    this.status = status;
  }
}

/** 브라우저용. 로그인 쿠키를 사용하는 같은 출처의 API만 호출한다. */
export function createBrowserClient(fetcher: typeof fetch = fetch) {
  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin", cache: "no-store", signal,
      ...(body !== undefined ? { headers: {"Content-Type":"application/json"}, body:JSON.stringify(body) } : {}),
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new PaymentChatClientError("INVALID_RESPONSE","서버 응답을 확인할 수 없습니다.",response.status); }
    if (!response.ok) throw new PaymentChatClientError(
      typeof payload?.code === "string" ? payload.code : "INTERNAL_ERROR",
      typeof payload?.message === "string" ? payload.message : "요청을 처리하지 못했습니다.",
      response.status,
    );
    return payload as T;
  }
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
