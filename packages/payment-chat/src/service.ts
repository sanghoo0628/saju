import { randomUUID } from "node:crypto";
import { MATCH_PRICE_KRW } from "../../../contracts/payment-chat.ts";
import type { ApiErrorResponse, ChatMessage, CreateOrderResponse } from "../../../contracts/payment-chat.ts";
import type { Actor, Order, PaymentGateway, Repository, Transaction } from "./ports.ts";

export class ServiceError extends Error {
  code: ApiErrorResponse["code"];
  constructor(code: ApiErrorResponse["code"], message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}
function requireActor(actor: Actor): string {
  if (!actor?.userId) throw new ServiceError("UNAUTHENTICATED", "로그인이 필요합니다.");
  return actor.userId;
}
function invalid(message: string): never { throw new ServiceError("INVALID_REQUEST", message); }
function forbidden(): never { throw new ServiceError("FORBIDDEN", "접근할 수 없습니다."); }
async function ownOrder(tx: Transaction, id: string, userId: string): Promise<Order> {
  const order = await tx.order(id);
  if (!order || order.userId !== userId) forbidden();
  return order;
}
async function availablePair(tx: Transaction, a: string, b: string) {
  if (await tx.blocked(a, b)) throw new ServiceError("BLOCKED", "대화할 수 없는 상대입니다.");
}
async function participant(tx: Transaction, id: string, userId: string) {
  const room = await tx.conversation(id);
  if (!room || !room.members.includes(userId)) forbidden();
  await availablePair(tx, ...room.members);
  return room;
}

/** 서버 전용. 브라우저 번들에서 불러오지 않는다. 결제 제공자/DB 구현은 주입한다. */
export function createService(deps: {
  repository: Repository;
  gateway: PaymentGateway;
  id?: () => string;
  now?: () => string;
}) {
  const { repository, gateway } = deps;
  const id = deps.id ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!gateway.productId) invalid("결제 상품 설정이 필요합니다.");

  return {
    async createOrder(actor: Actor, matchResultId: string): Promise<CreateOrderResponse> {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        const result = await tx.result(matchResultId);
        if (!result || result.userId !== userId || result.targetId === userId) forbidden();
        await availablePair(tx, userId, result.targetId);
        if (!(await tx.profileAvailable(result.targetId))) forbidden();
        const room = await tx.conversationForPair(userId, result.targetId);
        if (room) return { kind: "chat_available", conversationId: room.id };
        const existing = await tx.activeOrderForPair(userId, result.targetId);
        if (existing?.status === "fulfilled") return { kind: "chat_available", orderId: existing.id };
        if (existing?.status === "pending") return {
          kind: "payment_required", orderId: existing.id, amountKrw: existing.amountKrw,
          checkoutUrl: gateway.checkoutUrl(existing.reference),
        };
        const order: Order = {
          id: id(), userId, reference: id(), targetId: result.targetId, matchResultId,
          amountKrw: MATCH_PRICE_KRW, status: "pending",
        };
        const checkoutUrl = gateway.checkoutUrl(order.reference);
        if (new URL(checkoutUrl).protocol !== "https:") invalid("HTTPS 결제 주소가 필요합니다.");
        await tx.saveOrder(order);
        return { kind: "payment_required", orderId: order.id, amountKrw: order.amountKrw, checkoutUrl };
      });
    },

    async order(actor: Actor, orderId: string) {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        const order = await ownOrder(tx, orderId, userId);
        return { orderId, status: order.status, targetId: order.targetId };
      });
    },

    /** 원문 body를 그대로 전달한다. JSON 파싱 후 재직렬화한 body는 서명 검증에 쓰지 않는다. */
    async paymentWebhook(rawBody: Uint8Array, headers: Headers) {
      const payment = await gateway.verifyCompleted(rawBody, headers);
      if (!payment.reference || !payment.transactionId || payment.productId !== gateway.productId ||
          payment.currency !== "KRW" || payment.amount !== MATCH_PRICE_KRW)
        invalid("결제 내용이 주문과 일치하지 않습니다.");

      return repository.transaction(async tx => {
        const order = await tx.orderByReference(payment.reference);
        if (!order) invalid("알 수 없는 주문입니다.");
        const linkedOrder = await tx.paymentOrder(payment.transactionId);
        if (linkedOrder && linkedOrder !== order.id) invalid("이미 다른 주문에 사용된 결제입니다.");
        if (order.amountKrw !== payment.amount) invalid("주문 금액이 일치하지 않습니다.");
        if (["fulfilled", "refund_pending", "refunded"].includes(order.status)) {
          if (linkedOrder !== order.id) invalid("이미 완료된 주문의 다른 결제입니다.");
          return { orderId: order.id, status: order.status };
        }
        if (order.status !== "pending")
          invalid("처리할 수 없는 주문 상태입니다.");
        await tx.savePayment(payment.transactionId, order.id);
        if (!(await tx.profileAvailable(order.targetId)) || await tx.blocked(order.userId, order.targetId)) {
          // 대상을 임의로 바꾸지 않는다. 결제 사실을 보존하고 환불 처리로 넘긴다.
          await tx.saveOrder({ ...order, status: "refund_pending" });
          return { orderId: order.id, status: "refund_pending" as const };
        }
        await tx.saveOrder({ ...order, status: "fulfilled" });
        return { orderId: order.id, status: "fulfilled" as const };
      });
    },

    async requestChat(actor: Actor, orderId: string) {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        const order = await ownOrder(tx, orderId, userId);
        if (order.status !== "fulfilled" || order.targetId === userId) forbidden();
        await availablePair(tx, userId, order.targetId);
        if (!(await tx.profileAvailable(order.targetId))) forbidden();
        const existing = await tx.requestForPair(userId, order.targetId);
        if (existing) return existing; // 거절 후 반복 요청도 생성하지 않는다.
        const request = { id: id(), from: userId, to: order.targetId, orderId, status: "pending" as const };
        await tx.saveRequest(request);
        return request;
      });
    },

    async acceptChat(actor: Actor, requestId: string) {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        const request = await tx.request(requestId);
        if (!request || request.to !== userId) forbidden();
        if (request.status === "rejected") invalid("이미 거절한 요청입니다.");
        await availablePair(tx, request.from, request.to);
        // 수락 직전에도 원래 구매 권한이 살아 있는지 확인한다.
        const order = await ownOrder(tx, request.orderId, request.from);
        if (order.status !== "fulfilled" || order.targetId !== userId) forbidden();
        if (!(await tx.profileAvailable(request.from)) || !(await tx.profileAvailable(request.to))) forbidden();
        const room = await tx.conversationForPair(request.from, request.to) ?? {
          id: id(), members: [request.from, request.to] as [string, string],
        };
        await tx.saveConversation(room);
        await tx.saveRequest({ ...request, status: "accepted" });
        return { conversationId: room.id };
      });
    },

    async rejectChat(actor: Actor, requestId: string) {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        const request = await tx.request(requestId);
        if (!request || request.to !== userId) forbidden();
        if (request.status === "accepted") invalid("이미 수락한 요청입니다.");
        const rejected = { ...request, status: "rejected" as const };
        await tx.saveRequest(rejected);
        return rejected;
      });
    },

    async sendMessage(actor: Actor, conversationId: string, body: string) {
      const userId = requireActor(actor);
      if (typeof body !== "string" || !body.trim() || body.length > 2000)
        invalid("메시지는 1~2000자로 입력해주세요.");
      return repository.transaction(async tx => {
        await participant(tx, conversationId, userId);
        const message: ChatMessage = { id: id(), conversationId, senderId: userId, body: body.trim(), createdAt: now() };
        await tx.saveMessage(message);
        return message;
      });
    },

    async messages(actor: Actor, conversationId: string, afterId?: string) {
      const userId = requireActor(actor);
      return repository.transaction(async tx => {
        await participant(tx, conversationId, userId);
        return tx.messages(conversationId, afterId);
      });
    },
  };
}
